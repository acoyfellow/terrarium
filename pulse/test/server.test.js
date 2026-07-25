import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const at = () => new Date().toISOString();

function harness() {
  const app = createApp({ token: TOKEN });
  const call = (path, init = {}) => app.request(path, init);
  const post = (path, body, headers = auth) =>
    call(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { app, call, post };
}

test('GET /health needs no auth', async () => {
  const { call } = harness();
  const res = await call('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'pulse' });
});

test('protected routes fail closed without a valid token', async () => {
  const { call } = harness();
  const res = await call('/status?subscriberId=s');
  assert.equal(res.status, 401);
  const bad = await call('/status?subscriberId=s', { headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);
});

test('end-to-end over HTTP: subscribe -> emit -> claim -> ack -> status', async () => {
  const { post, call } = harness();

  const sub = await post('/pulse', { action: 'subscribe', subscriberId: 'docs', channels: ['docs'] });
  assert.equal(sub.status, 200);

  const emit = await post('/pulse', {
    action: 'emit',
    event: { type: 'Completed', runId: 'r1', at: at(), channel: 'docs', status: 'ok' },
  });
  const emitBody = await emit.json();
  assert.equal(emitBody.ok, true);
  assert.equal(emitBody.result.delivered, 1);
  const eventId = emitBody.result.eventId;

  const claim = await post('/claim', { subscriberId: 'docs' });
  const claimBody = await claim.json();
  assert.equal(claimBody.result.events.length, 1);

  const ack = await post('/ack', { subscriberId: 'docs', eventId });
  assert.equal((await ack.json()).result.acknowledged, true);

  const status = await call('/status?subscriberId=docs', { headers: auth });
  assert.deepEqual((await status.json()).result, {
    subscriberId: 'docs', pending: 0, inflight: 0, acknowledged: 1, dead: 0,
  });
});

test('unknown action and not-found map to 400/404', async () => {
  const { post, call } = harness();
  const unknown = await post('/pulse', { action: 'frobnicate' });
  assert.equal(unknown.status, 400);
  const nf = await call('/nope', { headers: auth });
  assert.equal(nf.status, 404);
});

test('owner mismatch maps to 403', async () => {
  const { post } = harness();
  await post('/pulse', { action: 'subscribe', subscriberId: 's', channels: ['c'], ownerRunId: 'ter_a' });
  const res = await post('/claim', { subscriberId: 's', ownerRunId: 'ter_b' });
  assert.equal(res.status, 403);
});
