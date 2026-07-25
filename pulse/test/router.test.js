import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PulseRouter } from '../src/router.js';

const at = () => new Date().toISOString();

test('full lifecycle: subscribe -> emit -> claim -> ack', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 'docs', channels: ['docs'] });
  const routed = await r.route({ type: 'Completed', runId: 'r1', at: at(), channel: 'docs', status: 'ok' });
  assert.equal(routed.duplicate, false);
  assert.equal(routed.delivered, 1);

  const claimed = r.claim({ subscriberId: 'docs' });
  assert.equal(claimed.events.length, 1);
  assert.equal(claimed.events[0].eventId, routed.eventId);
  assert.ok(claimed.events[0].claimedAt);

  const acked = r.ack({ subscriberId: 'docs', eventId: routed.eventId });
  assert.equal(acked.acknowledged, true);

  const st = r.status('docs');
  assert.deepEqual(st, { subscriberId: 'docs', pending: 0, inflight: 0, acknowledged: 1, dead: 0 });
});

test('route dedupes identical events by derived id', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 's', channels: ['c'] });
  const ev = { type: 'Completed', runId: 'r', at: '2026-06-30T00:00:00.000Z', channel: 'c', status: 'ok', exitCode: 0 };
  const a = await r.route(ev);
  const b = await r.route({ ...ev });
  assert.equal(a.eventId, b.eventId);
  assert.equal(b.duplicate, true);
  assert.equal(b.delivered, 0);
  assert.equal(r.status('s').pending, 1);
});

test('claim dedups: an event is delivered at most once per mailbox', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 's', channels: ['c'] });
  const ev = await r.route({ type: 'Completed', runId: 'r', at: at(), channel: 'c' });
  const first = r.claim({ subscriberId: 's' });
  const second = r.claim({ subscriberId: 's' });
  assert.equal(first.events.length, 1);
  assert.equal(second.events.length, 0);
  assert.equal(first.events[0].eventId, ev.eventId);
});

test('ack is idempotent and rejects non-inflight', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 's', channels: ['c'] });
  const ev = await r.route({ type: 'Failed', runId: 'r', at: at(), channel: 'c' });
  assert.throws(() => r.ack({ subscriberId: 's', eventId: ev.eventId }), /not inflight/);
  r.claim({ subscriberId: 's' });
  assert.equal(r.ack({ subscriberId: 's', eventId: ev.eventId }).acknowledged, true);
  assert.equal(r.ack({ subscriberId: 's', eventId: ev.eventId }).duplicate, true);
});

test('requeue moves stale inflight back to pending and bumps deliveryAttempts', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 's', channels: ['c'] });
  await r.route({ type: 'Completed', runId: 'r', at: at(), channel: 'c' });
  r.claim({ subscriberId: 's' });
  const res = r.requeue({ subscriberId: 's', olderThanMs: 0 });
  assert.equal(res.requeued, 1);
  assert.equal(res.maxAttempts, 1);
  const reclaim = r.claim({ subscriberId: 's' });
  assert.equal(reclaim.events.length, 1);
  assert.equal(reclaim.events[0].deliveryAttempts, 1);
});

test('claim quarantines poison events at maxDeliveryAttempts', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 's', channels: ['c'] });
  await r.route({ type: 'Completed', runId: 'r', at: at(), channel: 'c' });
  // claim + requeue twice to reach deliveryAttempts=2
  r.claim({ subscriberId: 's' });
  r.requeue({ subscriberId: 's', olderThanMs: 0 });
  r.claim({ subscriberId: 's' });
  r.requeue({ subscriberId: 's', olderThanMs: 0 });
  const claimed = r.claim({ subscriberId: 's', maxDeliveryAttempts: 2 });
  assert.equal(claimed.events.length, 0);
  assert.equal(claimed.quarantined, 1);
  assert.equal(r.status('s').dead, 1);
});

test('concrete-run subscription replays journal (finish-before-subscribe)', async () => {
  const r = new PulseRouter();
  const ev = await r.route({ type: 'Completed', runId: 'ter_abc', at: at(), channel: 'c' });
  // subscribe AFTER the event was journalled
  const sub = await r.subscribe({ subscriberId: 's', runIds: ['ter_abc'] });
  assert.equal(sub.replayed, 1);
  assert.equal(r.claim({ subscriberId: 's' }).events[0].eventId, ev.eventId);
});

test('wildcard subscription does not replay history', async () => {
  const r = new PulseRouter();
  await r.route({ type: 'Completed', runId: 'r', at: at(), channel: 'c' });
  const sub = await r.subscribe({ subscriberId: 's', channels: ['c'] });
  assert.equal(sub.replayed, 0);
  assert.equal(r.status('s').pending, 0);
});

test('owner isolation: another owner cannot claim/status/ack', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 's', channels: ['c'], ownerRunId: 'ter_owner1' });
  await r.route({ type: 'Completed', runId: 'r', at: at(), channel: 'c' });
  assert.throws(() => r.claim({ subscriberId: 's', ownerRunId: 'ter_owner2' }), /access denied/);
  assert.throws(() => r.status('s', 'ter_owner2'), /access denied/);
  // correct owner works
  assert.equal(r.claim({ subscriberId: 's', ownerRunId: 'ter_owner1' }).events.length, 1);
});

test('re-subscribe cannot re-home an owned subscriber', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 's', ownerRunId: 'ter_a' });
  await assert.rejects(r.subscribe({ subscriberId: 's', ownerRunId: 'ter_b' }), /owned by another/);
});

test('fan-out delivers one event to multiple matching subscribers', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 'a', channels: ['c'] });
  await r.subscribe({ subscriberId: 'b', channels: ['c'] });
  const res = await r.route({ type: 'Completed', runId: 'r', at: at(), channel: 'c' });
  assert.equal(res.delivered, 2);
});

test('prune removes acked + aged journal but keeps live subscribers', async () => {
  const r = new PulseRouter();
  await r.subscribe({ subscriberId: 's', channels: ['c'] });
  const ev = await r.route({ type: 'Completed', runId: 'r', at: at(), channel: 'c' });
  r.claim({ subscriberId: 's' });
  r.ack({ subscriberId: 's', eventId: ev.eventId });
  const res = r.prune({ acknowledgedOlderThanMs: 0, journalOlderThanMs: 0, subscriberOlderThanMs: Infinity });
  assert.equal(res.acknowledgedRemoved, 1);
  assert.equal(res.journalRemoved, 1);
  assert.ok(r.getSubscriber('s'));
});
