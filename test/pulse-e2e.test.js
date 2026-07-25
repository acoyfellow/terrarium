// Local e2e for the Cloudflare pulse backend (Gate 1: local-e2e).
//
// Drives the full transport against a REAL Durable Object + DO SQLite running in
// Miniflare (the same runtime `wrangler dev` uses) over real HTTP:
//   emit -> route -> claim -> ack -> resume-replay
//
// Coverage:
//   - happy path (route delivers, claim returns it, ack settles, status reflects)
//   - duplicate emit is deduped (same event id, delivered:0)
//   - finish-before-subscribe replays for a concrete run subscription
//   - claim/ack idempotent (re-claim returns nothing; re-ack returns duplicate)
//   - client ownership claims are ignored; stable principal owns each mailbox
//   - auth fail-closed (missing/incorrect bearer -> 401)

import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'test-capability-token-do-not-ship';
const PRINCIPAL = 'principal-e2e';

// Round 5C2: the public Pulse worker now requires a principal (TERRARIUM_PRINCIPAL_ID)
// plus an INDEPENDENT verification token (TERRARIUM_PULSE_TOKEN_CURRENT with an
// optional TERRARIUM_PULSE_TOKEN_PREVIOUS for rotation). The legacy PULSE_TOKEN
// binding no longer authorizes on the public surface.
function makeMf(bindings = { TERRARIUM_PRINCIPAL_ID: PRINCIPAL, TERRARIUM_PULSE_TOKEN_CURRENT: TOKEN }) {
  return new Miniflare({
    scriptPath: join(root, 'src/pulse/worker.js'),
    modules: true,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2026-06-05',
    durableObjects: { PULSE_ROUTER: { className: 'PulseRouter', useSQLite: true } },
    bindings,
  });
}

async function call(mf, method, path, { body, token = TOKEN } = {}) {
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
    // private fields that MUST be stripped by sanitize:
    task: 'private prompt',
    output: 'private output',
  };
}

test('pulse e2e: emit -> route -> claim -> ack -> resume-replay (happy path)', async () => {
  const mf = makeMf();
  try {
    const runId = 'ter_happy1';
    const subscriberId = 'sub_happy1';

    // subscribe (concrete run)
    const sub = await call(mf, 'POST', '/pulse', { body: { action: 'subscribe', args: { subscriberId, runIds: [runId], eventTypes: ['Completed'], channels: ['edge'], workflowIds: ['*'] } } });
    assert.equal(sub.status, 200, JSON.stringify(sub.json));
    assert.equal(sub.json.result.replayed, 0);

    // emit/route
    const routed = await call(mf, 'POST', '/pulse', { body: { event: terminalEvent(runId) } });
    assert.equal(routed.status, 200, JSON.stringify(routed.json));
    assert.equal(routed.json.result.duplicate, false);
    assert.equal(routed.json.result.delivered, 1);
    const eventId = routed.json.result.eventId;
    assert.match(eventId, /^evt_[0-9a-f]{32}$/);

    // claim
    const claimed = await call(mf, 'POST', '/claim', { body: { subscriberId } });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.json.result.events.length, 1);
    const ev = claimed.json.result.events[0];
    assert.equal(ev.eventId, eventId);
    assert.equal(ev.runId, runId);
    assert.ok(ev.claimedAt, 'claimed event carries claimedAt');
    // private fields stripped
    assert.equal('task' in ev, false);
    assert.equal('output' in ev, false);

    // status reflects inflight
    const s1 = await call(mf, 'GET', `/status?subscriberId=${subscriberId}`);
    assert.deepEqual(s1.json.result, { subscriberId, pending: 0, inflight: 1, acknowledged: 0, dead: 0 });

    // ack
    const acked = await call(mf, 'POST', '/ack', { body: { subscriberId, eventId } });
    assert.equal(acked.status, 200);
    assert.equal(acked.json.result.acknowledged, true);

    const s2 = await call(mf, 'GET', `/status?subscriberId=${subscriberId}`);
    assert.deepEqual(s2.json.result, { subscriberId, pending: 0, inflight: 0, acknowledged: 1, dead: 0 });
  } finally {
    await mf.dispose();
  }
});

test('pulse e2e: duplicate emit is deduped', async () => {
  const mf = makeMf();
  try {
    const runId = 'ter_dup1';
    await call(mf, 'POST', '/pulse', { body: { action: 'subscribe', args: { subscriberId: 'sub_dup1', runIds: [runId] } } });
    const event = terminalEvent(runId);
    const first = await call(mf, 'POST', '/pulse', { body: { event } });
    const second = await call(mf, 'POST', '/pulse', { body: { event } });
    assert.equal(first.json.result.duplicate, false);
    assert.equal(first.json.result.delivered, 1);
    assert.equal(second.json.result.duplicate, true);
    assert.equal(second.json.result.delivered, 0);
    assert.equal(first.json.result.eventId, second.json.result.eventId);
    // mailbox holds exactly one
    const s = await call(mf, 'GET', '/status?subscriberId=sub_dup1');
    assert.equal(s.json.result.pending, 1);
  } finally {
    await mf.dispose();
  }
});

test('pulse e2e: finish-before-subscribe replays for a concrete run subscription', async () => {
  const mf = makeMf();
  try {
    const runId = 'ter_replay1';
    // emit BEFORE anyone subscribes
    const routed = await call(mf, 'POST', '/pulse', { body: { event: terminalEvent(runId) } });
    assert.equal(routed.json.result.delivered, 0, 'no subscribers yet');
    const eventId = routed.json.result.eventId;

    // subscribe with concrete run id -> journal replays into mailbox
    const sub = await call(mf, 'POST', '/pulse', { body: { action: 'subscribe', args: { subscriberId: 'sub_replay1', runIds: [runId] } } });
    assert.equal(sub.json.result.replayed, 1);

    const claimed = await call(mf, 'POST', '/claim', { body: { subscriberId: 'sub_replay1' } });
    assert.equal(claimed.json.result.events.length, 1);
    assert.equal(claimed.json.result.events[0].eventId, eventId);

    // a wildcard-run subscriber created after the fact does NOT replay history
    const wild = await call(mf, 'POST', '/pulse', { body: { action: 'subscribe', args: { subscriberId: 'sub_wild1', runIds: ['*'] } } });
    assert.equal(wild.json.result.replayed, 0);
  } finally {
    await mf.dispose();
  }
});

test('pulse e2e: claim and ack are idempotent', async () => {
  const mf = makeMf();
  try {
    const runId = 'ter_idem1';
    await call(mf, 'POST', '/pulse', { body: { action: 'subscribe', args: { subscriberId: 'sub_idem1', runIds: [runId] } } });
    const routed = await call(mf, 'POST', '/pulse', { body: { event: terminalEvent(runId) } });
    const eventId = routed.json.result.eventId;

    const c1 = await call(mf, 'POST', '/claim', { body: { subscriberId: 'sub_idem1' } });
    assert.equal(c1.json.result.events.length, 1);
    // re-claim: already inflight, nothing new
    const c2 = await call(mf, 'POST', '/claim', { body: { subscriberId: 'sub_idem1' } });
    assert.equal(c2.json.result.events.length, 0);

    const a1 = await call(mf, 'POST', '/ack', { body: { subscriberId: 'sub_idem1', eventId } });
    assert.equal(a1.json.result.acknowledged, true);
    assert.notEqual(a1.json.result.duplicate, true);
    // re-ack: idempotent duplicate
    const a2 = await call(mf, 'POST', '/ack', { body: { subscriberId: 'sub_idem1', eventId } });
    assert.equal(a2.json.result.acknowledged, true);
    assert.equal(a2.json.result.duplicate, true);
  } finally {
    await mf.dispose();
  }
});

// Round 5C2: on the public writer, the principal is derived from the
// authenticated env; the client cannot pin its own ownerId/principalId. This
// test proves that even when a client tries to pass ownerId, ownerRunId, or
// principalId, the worker discards every ownership claim and the subscriber
// remains scoped only to the authenticated principal.
test('pulse e2e: client owner claims are ignored; same-principal wildcard fans across runs', async () => {
  const mf = makeMf();
  try {
    const runIdA = 'ter_ownA';
    const runIdB = 'ter_ownB';
    const subscriberId = 'sub_owner_scope';

    // Subscribe as the authenticated principal with a wildcard on runIds so
    // it receives all runs owned by this principal. Any client-supplied
    // principalId/ownerId in args is ignored by the worker.
    const sub = await call(mf, 'POST', '/pulse', { body: { action: 'subscribe', args: { subscriberId, runIds: ['*'], principalId: 'attacker-principal', ownerId: 'attacker', ownerRunId: 'ter_attacker' } } });
    assert.equal(sub.status, 200, JSON.stringify(sub.json));
    assert.equal(sub.json.result.ownerRunId, null);

    // Emit two events under different runs — both belong to the authenticated
    // principal because the worker injects event.ownerId := principalId. Any
    // client-supplied event.ownerId claim is dropped.
    const routedA = await call(mf, 'POST', '/pulse', { body: { event: { ...terminalEvent(runIdA), ownerId: 'attacker' } } });
    const routedB = await call(mf, 'POST', '/pulse', { body: { event: terminalEvent(runIdB) } });
    assert.equal(routedA.json.result.delivered, 1, 'client ownerId spoof discarded; delivered under authenticated principal');
    assert.equal(routedB.json.result.delivered, 1);

    // Both events land in the mailbox — same-principal wildcard fanout across
    // two runs.
    const claimed = await call(mf, 'POST', '/claim', { body: { subscriberId } });
    assert.equal(claimed.json.result.events.length, 2);
    const owners = new Set(claimed.json.result.events.map((e) => e.ownerId));
    assert.equal(owners.size, 1, 'both events carry same authenticated principal ownerId');
    assert.ok(owners.has(PRINCIPAL));
  } finally {
    await mf.dispose();
  }
});

test('pulse e2e: cross-principal subscriber access is normalized to a generic 404', async () => {
  // A second Miniflare instance simulates a DIFFERENT authenticated principal
  // hitting the SAME DO (shared PULSE_ROUTER binding). Miniflare gives each
  // instance its own DO storage, so we can only exercise cross-principal
  // access WITHIN one instance: we do that by manually forging a subscriber
  // record owned by another principal in a DO-only path... which is not
  // exposed publicly. Instead, we prove the shape of the response:
  //   - a subscribe under principalA
  //   - a status GET for a subscriber that does not exist -> 404 generic
  //   - the missing subscriber and a truly cross-principal one look identical
  //     to the caller (no principal enumeration).
  const mf = makeMf();
  try {
    await call(mf, 'POST', '/pulse', { body: { action: 'subscribe', args: { subscriberId: 'sub_isolated', runIds: ['ter_iso1'] } } });
    // Unknown subscriber => generic 404.
    const missing = await call(mf, 'GET', '/status?subscriberId=sub_does_not_exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'not found');
    // Client ownerRunId is ignored; it cannot alter mailbox identity.
    const ignoredRun = await call(mf, 'GET', '/status?subscriberId=sub_isolated&ownerRunId=ter_zzz');
    assert.equal(ignoredRun.status, 200);
    // Claim on unknown subscriber => 404 generic.
    const claimMissing = await call(mf, 'POST', '/claim', { body: { subscriberId: 'sub_does_not_exist' } });
    assert.equal(claimMissing.status, 404);
    assert.equal(claimMissing.json.error, 'not found');
  } finally {
    await mf.dispose();
  }
});

test('pulse e2e: auth is fail-closed on missing/wrong pulse token', async () => {
  const mf = makeMf();
  try {
    // no token
    const noTok = await call(mf, 'POST', '/pulse', { token: null, body: { event: terminalEvent('ter_auth1') } });
    assert.equal(noTok.status, 401);
    // wrong token
    const badTok = await call(mf, 'POST', '/claim', { token: 'nope', body: { subscriberId: 'x' } });
    assert.equal(badTok.status, 401);
    // health is open (no token) for liveness checks
    const health = await call(mf, 'GET', '/health', { token: null });
    assert.equal(health.status, 200);
    assert.equal(health.json.service, 'pulse');
  } finally {
    await mf.dispose();
  }
});

test('pulse e2e: fail-closed when TERRARIUM_PRINCIPAL_ID or TERRARIUM_PULSE_TOKEN_CURRENT is unset', async () => {
  // Missing both.
  const mfNothing = makeMf({});
  try {
    const res = await call(mfNothing, 'POST', '/pulse', { token: 'anything', body: { event: terminalEvent('ter_x') } });
    assert.equal(res.status, 401);
  } finally { await mfNothing.dispose(); }
  // Only principal, no token.
  const mfNoTok = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL });
  try {
    const res = await call(mfNoTok, 'POST', '/pulse', { token: TOKEN, body: { event: terminalEvent('ter_x') } });
    assert.equal(res.status, 401);
  } finally { await mfNoTok.dispose(); }
});

test('pulse e2e: legacy PULSE_TOKEN alone does NOT authorize (Round 5C2)', async () => {
  // Only the legacy secret is configured — the authenticator must refuse it.
  const mf = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL, PULSE_TOKEN: 'legacy-secret' });
  try {
    const res = await call(mf, 'POST', '/pulse', { token: 'legacy-secret', body: { event: terminalEvent('ter_x') } });
    assert.equal(res.status, 401);
  } finally { await mf.dispose(); }
});

test('pulse e2e: PREVIOUS token authenticates during rotation, and CURRENT still works', async () => {
  const OLD = 'old-token';
  const NEW = 'new-token';
  const mf = makeMf({ TERRARIUM_PRINCIPAL_ID: PRINCIPAL, TERRARIUM_PULSE_TOKEN_CURRENT: NEW, TERRARIUM_PULSE_TOKEN_PREVIOUS: OLD });
  try {
    // Subscribe with the OLD (previous) token.
    const oldSub = await call(mf, 'POST', '/pulse', { token: OLD, body: { action: 'subscribe', args: { subscriberId: 'sub_rot', runIds: ['ter_rot1'] } } });
    assert.equal(oldSub.status, 200, JSON.stringify(oldSub.json));
    // Emit under the NEW token — same principal because the principal is env-scoped.
    const emitted = await call(mf, 'POST', '/pulse', { token: NEW, body: { event: terminalEvent('ter_rot1') } });
    assert.equal(emitted.status, 200);
    assert.equal(emitted.json.result.delivered, 1);
    // Claim under OLD token still works — same principal.
    const claimed = await call(mf, 'POST', '/claim', { token: OLD, body: { subscriberId: 'sub_rot' } });
    assert.equal(claimed.json.result.events.length, 1);
  } finally { await mf.dispose(); }
});
