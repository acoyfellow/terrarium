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
//   - cross-owner cannot claim (ownerRunId mismatch -> 403)
//   - auth fail-closed (missing/incorrect bearer -> 401)

import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'test-capability-token-do-not-ship';

function makeMf(bindings = { PULSE_TOKEN: TOKEN }) {
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
    assert.deepEqual(s1.json.result, { subscriberId, pending: 0, inflight: 1, acknowledged: 0 });

    // ack
    const acked = await call(mf, 'POST', '/ack', { body: { subscriberId, eventId } });
    assert.equal(acked.status, 200);
    assert.equal(acked.json.result.acknowledged, true);

    const s2 = await call(mf, 'GET', `/status?subscriberId=${subscriberId}`);
    assert.deepEqual(s2.json.result, { subscriberId, pending: 0, inflight: 0, acknowledged: 1 });
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

test('pulse e2e: cross-owner cannot claim, ack, or read status', async () => {
  const mf = makeMf();
  try {
    const runId = 'ter_owner1';
    const subscriberId = 'sub_owner1';
    const owner = 'ter_ownerA';
    const attacker = 'ter_ownerB';

    await call(mf, 'POST', '/pulse', { body: { action: 'subscribe', args: { subscriberId, runIds: [runId], ownerRunId: owner } } });
    const routed = await call(mf, 'POST', '/pulse', { body: { event: terminalEvent(runId) } });
    const eventId = routed.json.result.eventId;
    assert.equal(routed.json.result.delivered, 1);

    // wrong owner claim -> 403
    const badClaim = await call(mf, 'POST', '/claim', { body: { subscriberId, ownerRunId: attacker } });
    assert.equal(badClaim.status, 403, JSON.stringify(badClaim.json));

    // no owner supplied (acting as controller) also denied since subscriber is owned
    const noOwnerClaim = await call(mf, 'POST', '/claim', { body: { subscriberId } });
    assert.equal(noOwnerClaim.status, 403);

    // wrong owner status -> 403
    const badStatus = await call(mf, 'GET', `/status?subscriberId=${subscriberId}&ownerRunId=${attacker}`);
    assert.equal(badStatus.status, 403);

    // correct owner can claim and ack
    const goodClaim = await call(mf, 'POST', '/claim', { body: { subscriberId, ownerRunId: owner } });
    assert.equal(goodClaim.status, 200);
    assert.equal(goodClaim.json.result.events.length, 1);

    const badAck = await call(mf, 'POST', '/ack', { body: { subscriberId, eventId, ownerRunId: attacker } });
    assert.equal(badAck.status, 403);

    const goodAck = await call(mf, 'POST', '/ack', { body: { subscriberId, eventId, ownerRunId: owner } });
    assert.equal(goodAck.status, 200);
    assert.equal(goodAck.json.result.acknowledged, true);

    // re-subscribe attempt by attacker is rejected (owned by another run)
    const steal = await call(mf, 'POST', '/pulse', { body: { action: 'subscribe', args: { subscriberId, runIds: [runId], ownerRunId: attacker } } });
    assert.equal(steal.status, 403);
    assert.match(steal.json.error, /owned by another/);
  } finally {
    await mf.dispose();
  }
});

test('pulse e2e: auth is fail-closed', async () => {
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

test('pulse e2e: fail-closed when PULSE_TOKEN is unset in env', async () => {
  const mf = makeMf({}); // no PULSE_TOKEN
  try {
    const res = await call(mf, 'POST', '/pulse', { token: 'anything', body: { event: terminalEvent('ter_x') } });
    assert.equal(res.status, 401);
  } finally {
    await mf.dispose();
  }
});
