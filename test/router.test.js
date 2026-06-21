import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JOURNAL_DIR, MAILBOXES_DIR, SUBSCRIBERS_DIR, acknowledgeMailboxEvent, claimMailboxEvents, getMailboxStatus, registerSubscriber, routeEvent } from '../src/router.js';

test('callbacks route, deduplicate, claim, and acknowledge exactly once', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_${suffix}`;
  const runId = `ter_${suffix}`;
  const event = { eventId: `evt_${suffix}`, type: 'Completed', runId, workflowId: runId, channel: 'test', at: new Date().toISOString(), status: 'done', exitCode: 0 };
  try {
    await registerSubscriber({ subscriberId, runIds: [runId], eventTypes: ['Completed'], channels: ['test'], workflowIds: ['*'] });
    const first = await routeEvent(event);
    const duplicate = await routeEvent(event);
    assert.equal(first.delivered, 1);
    assert.equal(duplicate.duplicate, true);
    const claimed = await claimMailboxEvents({ subscriberId });
    assert.equal(claimed.events.length, 1);
    assert.equal(claimed.events[0].eventId, event.eventId);
    assert.equal((await claimMailboxEvents({ subscriberId })).events.length, 0);
    const ack = await acknowledgeMailboxEvent({ subscriberId, eventId: event.eventId });
    assert.equal(ack.acknowledged, true);
    const ackAgain = await acknowledgeMailboxEvent({ subscriberId, eventId: event.eventId });
    assert.equal(ackAgain.duplicate, true);
    assert.deepEqual(await getMailboxStatus(subscriberId), { subscriberId, pending: 0, inflight: 0, acknowledged: 1 });
  } finally {
    await rm(join(MAILBOXES_DIR, subscriberId), { recursive: true, force: true });
    await rm(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
    await rm(join(JOURNAL_DIR, `${event.eventId}.json`), { force: true });
  }
});

test('callback filters do not deliver unrelated runs', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_filter_${suffix}`;
  const eventId = `evt_filter_${suffix}`;
  try {
    await registerSubscriber({ subscriberId, runIds: [`ter_expected_${suffix}`], eventTypes: ['Completed'], channels: ['*'], workflowIds: ['*'] });
    const result = await routeEvent({ eventId, type: 'Completed', runId: `ter_other_${suffix}`, workflowId: 'w', channel: 'x', at: new Date().toISOString() });
    assert.equal(result.delivered, 0);
    assert.equal((await claimMailboxEvents({ subscriberId })).events.length, 0);
  } finally {
    await rm(join(MAILBOXES_DIR, subscriberId), { recursive: true, force: true });
    await rm(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
    await rm(join(JOURNAL_DIR, `${eventId}.json`), { force: true });
  }
});
