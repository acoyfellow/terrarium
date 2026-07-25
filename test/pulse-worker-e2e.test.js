// GATE 1 (local e2e through the REAL edge runtime) — pulse Worker + Durable Object.
//
// This drives the SHIPPING src/pulse/worker.js fetch handler against a REAL
// PulseRouter Durable Object backed by REAL DO SQLite, running in Miniflare —
// the same workerd runtime `wrangler dev` uses. No SQLite shim, no in-process
// class calls: every assertion below crosses real HTTP into the Worker, which
// fans out to the DO over a real stub.fetch().
//
// It asserts, in one linear scenario, the exact contract this round must prove:
//   emit            -> 200
//   status          -> shows pending
//   claim           -> returns the event (claimedAt set, private fields stripped)
//   ack             -> 200, settled
//   second claim    -> EMPTY (nothing left to claim after ack)
//   401 without token (fail-closed)
//   client ownership claims ignored; authenticated principal remains authoritative
//   finish-before-subscribe then subscribe replays the journaled event
//
// Companion to test/pulse-do.test.js (unit, SQLite shim) and test/pulse-e2e.test.js
// (broader Miniflare coverage). This file is the named GATE-1 proof: the full
// route surface of the Worker exercised through the real runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'gate1-capability-token-not-a-secret';
const PRINCIPAL = 'gate1-principal';

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

function terminalEvent(runId, { channel = 'edge' } = {}) {
  return {
    type: 'Completed',
    runId,
    workflowId: runId,
    channel,
    at: new Date().toISOString(),
    status: 'done',
    ok: true,
    exitCode: 0,
    // private fields that the DO MUST strip before journaling/delivery:
    task: 'private prompt',
    output: 'private output',
  };
}

test('gate1: full worker+DO+SQLite path — emit, status, claim, ack, second claim empty', async () => {
  const mf = makeMf();
  try {
    const runId = 'ter_gate1_run';
    const subscriberId = 'sub_gate1';

    // subscribe (concrete run, owned)
    const sub = await call(mf, 'POST', '/pulse', {
      body: { action: 'subscribe', args: { subscriberId, runIds: [runId], ownerRunId: 'ter_gate1_owner' } },
    });
    assert.equal(sub.status, 200, JSON.stringify(sub.json));

    // emit -> 200
    const routed = await call(mf, 'POST', '/pulse', { body: { event: terminalEvent(runId) } });
    assert.equal(routed.status, 200, JSON.stringify(routed.json));
    assert.equal(routed.json.result.delivered, 1);
    const eventId = routed.json.result.eventId;
    assert.match(eventId, /^evt_[0-9a-f]{32}$/);

    // status -> shows pending
    const sPending = await call(mf, 'GET', `/status?subscriberId=${subscriberId}&ownerRunId=ter_gate1_owner`);
    assert.equal(sPending.status, 200);
    assert.deepEqual(sPending.json.result, { subscriberId, pending: 1, inflight: 0, acknowledged: 0, dead: 0 });

    // claim -> returns the event (claimedAt set; private fields stripped)
    const claimed = await call(mf, 'POST', '/claim', { body: { subscriberId, ownerRunId: 'ter_gate1_owner' } });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.json.result.events.length, 1);
    const ev = claimed.json.result.events[0];
    assert.equal(ev.eventId, eventId);
    assert.equal(ev.runId, runId);
    assert.ok(ev.claimedAt);
    assert.equal('task' in ev, false);
    assert.equal('output' in ev, false);

    // ack -> 200, settled
    const acked = await call(mf, 'POST', '/ack', { body: { subscriberId, eventId, ownerRunId: 'ter_gate1_owner' } });
    assert.equal(acked.status, 200);
    assert.equal(acked.json.result.acknowledged, true);

    const sAcked = await call(mf, 'GET', `/status?subscriberId=${subscriberId}&ownerRunId=ter_gate1_owner`);
    assert.deepEqual(sAcked.json.result, { subscriberId, pending: 0, inflight: 0, acknowledged: 1, dead: 0 });

    // second claim -> EMPTY (nothing pending after ack)
    const claimed2 = await call(mf, 'POST', '/claim', { body: { subscriberId, ownerRunId: 'ter_gate1_owner' } });
    assert.equal(claimed2.status, 200);
    assert.equal(claimed2.json.result.events.length, 0, 'second claim is empty after ack');
  } finally {
    await mf.dispose();
  }
});

test('gate1: 401 without a bearer token (fail-closed) on every gated route', async () => {
  const mf = makeMf();
  try {
    const noTok = await call(mf, 'POST', '/pulse', { token: null, body: { event: terminalEvent('ter_g1_auth') } });
    assert.equal(noTok.status, 401);
    const noTokClaim = await call(mf, 'POST', '/claim', { token: null, body: { subscriberId: 'x' } });
    assert.equal(noTokClaim.status, 401);
    const noTokStatus = await call(mf, 'GET', '/status?subscriberId=x', { token: null });
    assert.equal(noTokStatus.status, 401);
    // wrong token also rejected
    const badTok = await call(mf, 'POST', '/ack', { token: 'wrong', body: { subscriberId: 'x', eventId: 'y' } });
    assert.equal(badTok.status, 401);
  } finally {
    await mf.dispose();
  }
});

test('gate1: client ownerRunId claims are ignored through the real worker', async () => {
  const mf = makeMf();
  try {
    const runId = 'ter_g1_owned';
    const subscriberId = 'sub_g1_owned';
    const subscribed = await call(mf, 'POST', '/pulse', {
      body: { action: 'subscribe', args: { subscriberId, runIds: [runId], ownerRunId: 'ter_g1_owner' } },
    });
    assert.equal(subscribed.json.result.ownerRunId, null);
    await call(mf, 'POST', '/pulse', { body: { event: terminalEvent(runId) } });

    const claimed = await call(mf, 'POST', '/claim', { body: { subscriberId, ownerRunId: 'ter_g1_intruder' } });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
    assert.equal(claimed.json.result.events.length, 1);
  } finally {
    await mf.dispose();
  }
});

// Browser / CORS contract (docs/PULSE.md "Browser / CORS"). These cross real
// HTTP into the Worker's fetch handler with an Origin header and assert the
// exact CORS headers — the documented guarantee that was previously untested.
test('gate1: OPTIONS preflight is answered 204 with CORS headers, pre-auth (no token)', async () => {
  const mf = makeMf();
  try {
    const origin = 'https://mote.dev.local:5173';
    // Deliberately NO authorization header — preflight is pre-auth.
    const res = await mf.dispatchFetch('https://pulse.local/claim', {
      method: 'OPTIONS',
      headers: { origin },
    });
    assert.equal(res.status, 204, 'OPTIONS preflight returns 204 without a bearer token');
    // echoes the request origin
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    const methods = res.headers.get('access-control-allow-methods') || '';
    for (const m of ['GET', 'POST', 'OPTIONS']) {
      assert.ok(methods.includes(m), `allow-methods contains ${m} (got: ${methods})`);
    }
    const allowHeaders = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    for (const h of ['authorization', 'content-type']) {
      assert.ok(allowHeaders.includes(h), `allow-headers contains ${h} (got: ${allowHeaders})`);
    }
  } finally {
    await mf.dispose();
  }
});

test('gate1: a 401 unauthorized response still carries Access-Control-Allow-Origin', async () => {
  const mf = makeMf();
  try {
    const origin = 'https://mote.dev.local:5173';
    // Gated route with NO token -> 401, but the browser must still be able to read it.
    const res = await mf.dispatchFetch('https://pulse.local/claim', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ subscriberId: 'x' }),
    });
    assert.equal(res.status, 401, 'gated route without a token is 401');
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      origin,
      '401 still echoes the request origin so the browser can read the error',
    );
    const body = await res.json();
    assert.equal(body.error, 'unauthorized');
  } finally {
    await mf.dispose();
  }
});

test('gate1: finish-before-subscribe then subscribe replays the journaled event', async () => {
  const mf = makeMf();
  try {
    const runId = 'ter_g1_replay';
    // event finishes BEFORE any subscriber exists
    const routed = await call(mf, 'POST', '/pulse', { body: { event: terminalEvent(runId) } });
    assert.equal(routed.json.result.delivered, 0, 'no subscribers at route time');
    const eventId = routed.json.result.eventId;

    // subscribe with the concrete runId -> journal replays into the mailbox
    const sub = await call(mf, 'POST', '/pulse', {
      body: { action: 'subscribe', args: { subscriberId: 'sub_g1_replay', runIds: [runId], ownerRunId: 'ter_g1_owner' } },
    });
    assert.equal(sub.status, 200);
    assert.equal(sub.json.result.replayed, 1, 'finished event replayed on subscribe');

    const claimed = await call(mf, 'POST', '/claim', { body: { subscriberId: 'sub_g1_replay', ownerRunId: 'ter_g1_owner' } });
    assert.equal(claimed.json.result.events.length, 1);
    assert.equal(claimed.json.result.events[0].eventId, eventId);
  } finally {
    await mf.dispose();
  }
});
