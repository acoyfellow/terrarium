// Cloud Pulse principal-writer proofs (Round 5C2).
//
// This suite proves the stable-principal writer contract added to the public
// Pulse worker + PulseRouter DO:
//   1. Bounded principal-auth: TERRARIUM_PRINCIPAL_ID + independent
//      TERRARIUM_PULSE_TOKEN_CURRENT (with optional _PREVIOUS) are the ONLY
//      authorization inputs on the public surface. Legacy PULSE_TOKEN alone
//      does not authorize.
//   2. Subscribe/get/claim/ack/status/requeue/unsubscribe/prune all inject
//      the authenticated principalId; any client ownerId/principalId claim
//      in the body is discarded. Public route/emit forces event.ownerId to
//      the authenticated principal.
//   3. PulseRouter persists principal_id on every production subscription.
//      Rehoming attempts (a different principal against an existing
//      subscriberId) surface as a generic 404 anti-enumeration response.
//   4. Route fans out only to same-principal subscribers; cross-principal
//      wildcard subscribers never see another principal's event.
//   5. Same-principal wildcard receives every run belonging to the principal.
//   6. Finish-before-subscribe journal replay honors the same principal
//      isolation.
//   7. Current -> previous rotation preserves mailbox access.
//   8. Missing/cross-principal subscriber/event access normalizes to 404.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PRINCIPAL_A = 'principal-A';
const PRINCIPAL_B = 'principal-B';
const TOKEN_A = 'token-A-do-not-ship';
const TOKEN_B = 'token-B-do-not-ship';

function makeMf(bindings) {
  return new Miniflare({
    scriptPath: join(root, 'src/pulse/worker.js'),
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-06-05',
    durableObjects: { PULSE_ROUTER: { className: 'PulseRouter', useSQLite: true } },
    bindings,
  });
}

async function call(mf, method, path, { body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await mf.dispatchFetch(`https://pulse.local${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

function terminalEvent(runId, { channel = 'edge', type = 'Completed' } = {}) {
  return {
    type,
    runId,
    workflowId: runId,
    channel,
    at: new Date().toISOString(),
    status: 'done',
    ok: true,
    exitCode: 0,
    // Private fields must be stripped by the sanitize allowlist.
    task: 'private prompt',
    output: 'private output',
  };
}

// ---------------------- (1) Auth contract ----------------------

test('5C2 auth: missing principal or current token -> 401', async () => {
  for (const bindings of [
    {},
    { TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A },
    { TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_A },
  ]) {
    const mf = makeMf(bindings);
    try {
      const res = await call(mf, 'POST', '/pulse', { token: TOKEN_A, body: { event: terminalEvent('ter_missing') } });
      assert.equal(res.status, 401, JSON.stringify({ bindings, res }));
    } finally { await mf.dispose(); }
  }
});

test('5C2 auth: CURRENT and PREVIOUS both authorize; wrong token 401', async () => {
  const mf = makeMf({
    TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A,
    TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_A,
    TERRARIUM_PULSE_TOKEN_PREVIOUS: 'prev-token',
  });
  try {
    const okCurrent = await call(mf, 'GET', '/status?subscriberId=sub_notreal', { token: TOKEN_A });
    // sub_notreal doesn't exist yet -> anti-enum 404 but auth passed.
    assert.equal(okCurrent.status, 404, JSON.stringify(okCurrent.json));
    const okPrev = await call(mf, 'GET', '/status?subscriberId=sub_notreal', { token: 'prev-token' });
    assert.equal(okPrev.status, 404);
    const bad = await call(mf, 'GET', '/status?subscriberId=sub_notreal', { token: 'wrong' });
    assert.equal(bad.status, 401);
  } finally { await mf.dispose(); }
});

test('5C2 auth: legacy PULSE_TOKEN alone does NOT authorize even if bound', async () => {
  const mf = makeMf({
    TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A,
    PULSE_TOKEN: 'legacy',
    // No CURRENT: legacy-only setup must fail.
  });
  try {
    const res = await call(mf, 'POST', '/pulse', { token: 'legacy', body: { event: terminalEvent('ter_legacy') } });
    assert.equal(res.status, 401);
  } finally { await mf.dispose(); }
});

test('5C2 auth: a request presenting the legacy PULSE_TOKEN is refused even when CURRENT is configured', async () => {
  // Both are bound (transition setup). The authenticator must not accept a
  // bearer that matches the legacy value even though CURRENT is present.
  const mf = makeMf({
    TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A,
    TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_A,
    PULSE_TOKEN: 'legacy',
  });
  try {
    const res = await call(mf, 'POST', '/pulse', { token: 'legacy', body: { event: terminalEvent('ter_legacy2') } });
    assert.equal(res.status, 401);
    // But CURRENT still works.
    const ok = await call(mf, 'POST', '/pulse', { token: TOKEN_A, body: { action: 'subscribe', args: { subscriberId: 'sub_legacy_reject', runIds: ['*'] } } });
    assert.equal(ok.status, 200);
  } finally { await mf.dispose(); }
});

// ---------------------- (2) Client claim ignored ----------------------

test('5C2 client owner/principal claims are stripped by the worker', async () => {
  const mf = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A, TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_A });
  try {
    // Subscribe with claim: worker replaces principalId with authenticated one.
    const subscribed = await call(mf, 'POST', '/pulse', { token: TOKEN_A, body: { action: 'subscribe', args: { subscriberId: 'sub_claim', runIds: ['*'], principalId: PRINCIPAL_B, ownerId: 'attacker', ownerRunId: 'ter_attacker' } } });
    assert.equal(subscribed.json.result.principalId, PRINCIPAL_A);
    assert.equal(subscribed.json.result.ownerRunId, null, 'client ownerRunId is ignored');
    // Emit with a spoofed ownerId — worker forces event.ownerId to PRINCIPAL_A.
    const routed = await call(mf, 'POST', '/pulse', { token: TOKEN_A, body: { event: { ...terminalEvent('ter_claim_1'), ownerId: PRINCIPAL_B } } });
    assert.equal(routed.json.result.delivered, 1, 'delivered to same-principal wildcard subscriber');
    const claimed = await call(mf, 'POST', '/claim', { token: TOKEN_A, body: { subscriberId: 'sub_claim', principalId: PRINCIPAL_B } });
    assert.equal(claimed.json.result.events.length, 1);
    assert.equal(claimed.json.result.events[0].ownerId, PRINCIPAL_A, 'event.ownerId is the authenticated principal');
  } finally { await mf.dispose(); }
});

// ---------------------- (3, 4, 5) Cross-principal isolation ----------------------

test('5C2 authenticated missing-subscriber response is identical across principal configurations', async () => {
  // Miniflare gives each instance its own DO storage, so we cannot literally
  // share the DO across two authenticated principals. We simulate the check
  // by exercising both principals against separate instances and verifying
  // that a principal-B request against a principal-A subscriber name yields
  // a generic 404 (anti-enumeration). The DO's cross-principal fan-out
  // isolation is exercised additionally in the DO unit tests via
  // route(...) + a mixed subscriber table.
  const mfA = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A, TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_A });
  const mfB = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL_B, TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_B });
  try {
    await call(mfA, 'POST', '/pulse', { token: TOKEN_A, body: { action: 'subscribe', args: { subscriberId: 'sub_iso', runIds: ['*'] } } });
    await call(mfA, 'POST', '/pulse', { token: TOKEN_A, body: { event: terminalEvent('ter_iso_1') } });
    // From principal B (separate storage), same subscriberId does not exist.
    const claimB = await call(mfB, 'POST', '/claim', { token: TOKEN_B, body: { subscriberId: 'sub_iso' } });
    assert.equal(claimB.status, 404, 'cross-principal subscriber name is 404');
    assert.equal(claimB.json.error, 'not found');
    // But principal A can claim its own event.
    const claimA = await call(mfA, 'POST', '/claim', { token: TOKEN_A, body: { subscriberId: 'sub_iso' } });
    assert.equal(claimA.json.result.events.length, 1);
  } finally {
    await mfA.dispose();
    await mfB.dispose();
  }
});

test('5C2 same-principal wildcard subscriber receives all runs owned by the principal', async () => {
  const mf = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A, TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_A });
  try {
    await call(mf, 'POST', '/pulse', { token: TOKEN_A, body: { action: 'subscribe', args: { subscriberId: 'sub_wildp', runIds: ['*'] } } });
    for (const runId of ['ter_p1', 'ter_p2', 'ter_p3']) {
      const routed = await call(mf, 'POST', '/pulse', { token: TOKEN_A, body: { event: terminalEvent(runId) } });
      assert.equal(routed.json.result.delivered, 1, `wildcard receives ${runId}`);
    }
    const claimed = await call(mf, 'POST', '/claim', { token: TOKEN_A, body: { subscriberId: 'sub_wildp' } });
    assert.equal(claimed.json.result.events.length, 3);
  } finally { await mf.dispose(); }
});

// ---------------------- (6) Replay honors principal ----------------------

test('5C2 finish-before-subscribe replay honors principal isolation', async () => {
  const mfA = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A, TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_A });
  try {
    // Emit BEFORE anyone subscribes.
    const routed = await call(mfA, 'POST', '/pulse', { token: TOKEN_A, body: { event: terminalEvent('ter_rep1') } });
    assert.equal(routed.json.result.delivered, 0);
    // Subscribe with concrete run — journal replay must enqueue.
    const sub = await call(mfA, 'POST', '/pulse', { token: TOKEN_A, body: { action: 'subscribe', args: { subscriberId: 'sub_rep', runIds: ['ter_rep1'] } } });
    assert.equal(sub.json.result.replayed, 1);
    const claimed = await call(mfA, 'POST', '/claim', { token: TOKEN_A, body: { subscriberId: 'sub_rep' } });
    assert.equal(claimed.json.result.events.length, 1);
    assert.equal(claimed.json.result.events[0].ownerId, PRINCIPAL_A);
  } finally { await mfA.dispose(); }
});

// ---------------------- (7) Rotation ----------------------

test('5C2 CURRENT->PREVIOUS rotation preserves mailbox access for the same principal', async () => {
  const OLD = 'token-old';
  const NEW = 'token-new';
  const mf = makeMf({
    TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A,
    TERRARIUM_PULSE_TOKEN_CURRENT: NEW,
    TERRARIUM_PULSE_TOKEN_PREVIOUS: OLD,
  });
  try {
    // Subscribe with OLD.
    await call(mf, 'POST', '/pulse', { token: OLD, body: { action: 'subscribe', args: { subscriberId: 'sub_rot', runIds: ['*'] } } });
    // Emit under NEW.
    await call(mf, 'POST', '/pulse', { token: NEW, body: { event: terminalEvent('ter_rot_x') } });
    // Claim under OLD.
    const claimOld = await call(mf, 'POST', '/claim', { token: OLD, body: { subscriberId: 'sub_rot' } });
    assert.equal(claimOld.json.result.events.length, 1);
    // Ack under NEW.
    const ack = await call(mf, 'POST', '/ack', { token: NEW, body: { subscriberId: 'sub_rot', eventId: claimOld.json.result.events[0].eventId } });
    assert.equal(ack.json.result.acknowledged, true);
  } finally { await mf.dispose(); }
});

// ---------------------- (8) Subscriber hijack blocked ----------------------

test('5C2 public ownerRunId claims are ignored rather than becoming identity', async () => {
  const mf = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A, TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_A });
  try {
    const first = await call(mf, 'POST', '/pulse', { token: TOKEN_A, body: { action: 'subscribe', args: { subscriberId: 'sub_hijack', runIds: ['ter_a'], ownerRunId: 'ter_hija' } } });
    assert.equal(first.status, 200);
    assert.equal(first.json.result.ownerRunId, null);
    const retry = await call(mf, 'POST', '/pulse', { token: TOKEN_A, body: { action: 'subscribe', args: { subscriberId: 'sub_hijack', runIds: ['ter_b'], ownerRunId: 'ter_hijb' } } });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(retry.json.result.ownerRunId, null);
  } finally { await mf.dispose(); }
});

// ---------------------- (9) Anti-enum ----------------------

test('5C2 anti-enumeration: missing subscriber and unknown event yield generic 404', async () => {
  const mf = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL_A, TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN_A });
  try {
    await call(mf, 'POST', '/pulse', { token: TOKEN_A, body: { action: 'subscribe', args: { subscriberId: 'sub_ae', runIds: ['*'] } } });
    const missing = await call(mf, 'POST', '/claim', { token: TOKEN_A, body: { subscriberId: 'sub_missing' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'not found');
    const unknownEvent = await call(mf, 'POST', '/ack', { token: TOKEN_A, body: { subscriberId: 'sub_ae', eventId: 'evt_unknown' } });
    assert.equal(unknownEvent.status, 404);
    assert.equal(unknownEvent.json.error, 'not found');
  } finally { await mf.dispose(); }
});

// ---------------------- (10) DO-level cross-principal fan-out ----------------------

// Exercises the PulseRouter DO logic directly: mixed subscriber principals in
// one DO must never enqueue an event into another principal's mailbox. This
// is the strongest proof that the DO fan-out logic (not just the worker)
// enforces principal isolation.
import { PulseRouter } from '../src/pulse/do.js';
import { DatabaseSync } from 'node:sqlite';

function makeSqlShim() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(sql, ...bindings) {
      const isSelect = /^\s*SELECT/i.test(sql);
      if (bindings.length === 0 && !isSelect) { db.exec(sql); return { toArray: () => [] }; }
      const stmt = db.prepare(sql);
      if (isSelect) return { toArray: () => stmt.all(...bindings) };
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

test('5C2 DO fan-out: event.ownerId only enqueues to same-principal subscribers', async () => {
  const router = new PulseRouter({ storage: { sql: makeSqlShim() } });
  await router.subscribe({ subscriberId: 'subA', runIds: ['*'], principalId: PRINCIPAL_A });
  await router.subscribe({ subscriberId: 'subB', runIds: ['*'], principalId: PRINCIPAL_B });
  const routed = await router.route({
    type: 'Completed', runId: 'ter_a1', channel: 'default',
    at: '2026-07-01T10:00:00.000Z', status: 'done', ok: true, exitCode: 0,
    ownerId: PRINCIPAL_A,
  }, { requirePrincipalOwner: true });
  assert.equal(routed.delivered, 1, 'only subA (same principal) receives the event');
  assert.throws(() => router.claim({ subscriberId: 'subA', principalId: PRINCIPAL_B }), /subscriber not found/);
  assert.throws(() => router.status('subA', null, PRINCIPAL_B), /subscriber not found/);
  const claimA = router.claim({ subscriberId: 'subA', principalId: PRINCIPAL_A });
  assert.equal(claimA.events.length, 1);
  assert.throws(() => router.ack({ subscriberId: 'subA', eventId: claimA.events[0].eventId, principalId: PRINCIPAL_B }), /subscriber not found/);
  const claimB = router.claim({ subscriberId: 'subB', principalId: PRINCIPAL_B });
  assert.equal(claimB.events.length, 0);
});

test('5C2 DO replay: subscribe-after-emit only replays journal events with matching ownerId', async () => {
  const router = new PulseRouter({ storage: { sql: makeSqlShim() } });
  // Two events (A and B) journaled before anyone subscribes.
  await router.route({
    type: 'Completed', runId: 'ter_j_a', channel: 'default',
    at: '2026-07-01T10:00:00.000Z', status: 'done', ok: true, exitCode: 0,
    ownerId: PRINCIPAL_A,
  }, { requirePrincipalOwner: true });
  await router.route({
    type: 'Completed', runId: 'ter_j_b', channel: 'default',
    at: '2026-07-01T10:01:00.000Z', status: 'done', ok: true, exitCode: 0,
    ownerId: PRINCIPAL_B,
  }, { requirePrincipalOwner: true });
  // Principal A subscribes with concrete run ids — replay ONLY events from A.
  const subA = await router.subscribe({ subscriberId: 'lateA', runIds: ['ter_j_a', 'ter_j_b'], principalId: PRINCIPAL_A });
  assert.equal(subA.replayed, 1, 'principal A only replays its own journal entry');
  const claim = router.claim({ subscriberId: 'lateA', principalId: PRINCIPAL_A });
  assert.equal(claim.events.length, 1);
  assert.equal(claim.events[0].runId, 'ter_j_a');
});

test('5C2 DO: production route requires event.ownerId when requirePrincipalOwner=true', async () => {
  const router = new PulseRouter({ storage: { sql: makeSqlShim() } });
  await assert.rejects(() => router.route({
    type: 'Completed', runId: 'ter_missing_owner', channel: 'default',
    at: '2026-07-01T10:00:00.000Z', status: 'done', ok: true, exitCode: 0,
  }, { requirePrincipalOwner: true }), /invalid callback event/);
});

test('5C2 DO fetch rejects principal-less production subscriber operations', async () => {
  const router = new PulseRouter({ storage: { sql: makeSqlShim() } });
  const res = await router.fetch(new Request('https://pulse-do/op', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'subscribe', args: { subscriberId: 'no_principal', runIds: ['*'] } }),
  }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /principal is required/);
});

test('5C2 DO duplicate eventId cannot cross principal ownership', async () => {
  const router = new PulseRouter({ storage: { sql: makeSqlShim() } });
  const event = { eventId: 'evt_owned', type: 'Completed', runId: 'ter_owned', at: '2026-07-01T10:00:00.000Z', status: 'done', ok: true, exitCode: 0 };
  await router.route({ ...event, ownerId: PRINCIPAL_A }, { requirePrincipalOwner: true });
  await assert.rejects(
    () => router.route({ ...event, ownerId: PRINCIPAL_B }, { requirePrincipalOwner: true }),
    /event not found/,
  );
});

test('5C2 DO: subscriber cannot be re-homed to a different principal', async () => {
  const router = new PulseRouter({ storage: { sql: makeSqlShim() } });
  await router.subscribe({ subscriberId: 'sub_immut', runIds: ['*'], principalId: PRINCIPAL_A });
  await assert.rejects(
    () => router.subscribe({ subscriberId: 'sub_immut', runIds: ['*'], principalId: PRINCIPAL_B }),
    /subscriber not found/,
  );
});
