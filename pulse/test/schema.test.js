import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveEventId, sanitizeEvent, isValidEvent, matches, mergeFilters,
  boundedList, assertId, validTimestamp,
} from '../src/schema.js';

const at = '2026-06-30T00:00:00.000Z';

test('deriveEventId is deterministic and dedup-stable across receipt/deliveryAttempts', async () => {
  const a = await deriveEventId({ runId: 'r1', type: 'Completed', at, status: 'ok', exitCode: 0 });
  const b = await deriveEventId({ runId: 'r1', type: 'Completed', at, status: 'ok', exitCode: 0, receipt: { x: 1 }, deliveryAttempts: 3 });
  assert.equal(a, b);
  assert.match(a, /^evt_[0-9a-f]{32}$/);
});

test('deriveEventId honors an explicit valid eventId', async () => {
  assert.equal(await deriveEventId({ eventId: 'evt_explicit', runId: 'r' }), 'evt_explicit');
});

test('sanitizeEvent drops non-allowlisted keys', () => {
  const out = sanitizeEvent({ type: 'Completed', runId: 'r', at, secret: 'leak', __proto__: { hacked: true } });
  assert.deepEqual(Object.keys(out).sort(), ['at', 'runId', 'type']);
  assert.equal(out.secret, undefined);
});

test('isValidEvent enforces terminal type, keys, and timestamp', async () => {
  const id = await deriveEventId({ runId: 'r', type: 'Completed', at });
  const ev = { eventId: id, type: 'Completed', runId: 'r', at };
  assert.equal(isValidEvent(ev, id, { state: 'pending' }), true);
  assert.equal(isValidEvent({ ...ev, type: 'Bogus' }, id), false);
  assert.equal(isValidEvent({ ...ev, at: 'not-a-date' }, id), false);
  assert.equal(isValidEvent({ ...ev, extra: 1 }, id), false);
});

test('isValidEvent pending vs claimed state', async () => {
  const id = await deriveEventId({ runId: 'r', type: 'Completed', at });
  const claimed = { eventId: id, type: 'Completed', runId: 'r', at, claimedAt: at };
  assert.equal(isValidEvent(claimed, id, { state: 'claimed' }), true);
  assert.equal(isValidEvent(claimed, id, { state: 'pending' }), false);
});

test('matches honors filters and the pi-* wildcard guard', () => {
  const ev = { channel: 'docs', workflowId: 'w', type: 'Completed', runId: 'r1' };
  assert.equal(matches({ channels: ['docs'] }, ev), true);
  assert.equal(matches({ channels: ['other'] }, ev), false);
  assert.equal(matches({ runIds: ['r1'] }, ev), true);
  // pi-* subscriber with wildcard runIds must NOT match (no sibling wakeups).
  assert.equal(matches({ subscriberId: 'pi-session', runIds: ['*'] }, ev), false);
  assert.equal(matches({ subscriberId: 'pi-session', runIds: ['r1'] }, ev), true);
});

test('mergeFilters union, wildcard widen, and narrowWildcard', () => {
  assert.deepEqual(mergeFilters(['a'], ['b'], ['*']), ['b', 'a']);
  assert.deepEqual(mergeFilters(['*'], ['b'], ['*']), ['*']);
  assert.deepEqual(mergeFilters(['a'], ['*'], ['*']), ['*']);
  assert.deepEqual(mergeFilters(['a'], ['*'], ['*'], { narrowWildcard: true }), ['a']);
});

test('boundedList and assertId reject abuse', () => {
  assert.throws(() => boundedList([]), /invalid subscription filter/);
  assert.throws(() => assertId('bad id!', 'x'), /invalid x/);
  assert.equal(validTimestamp(at), true);
  assert.equal(validTimestamp('2026-06-30'), false);
});
