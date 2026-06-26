import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { JOURNAL_DIR, MAILBOXES_DIR, SUBSCRIBERS_DIR, acknowledgeMailboxEvent, claimMailboxEvents, getMailboxStatus, pruneRouter, registerSubscriber, requeueInflightEvents, routeEvent, unregisterSubscriber } from '../src/router.js';

test('callbacks route, deduplicate, claim, and acknowledge exactly once', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_${suffix}`;
  const runId = `ter_${suffix}`;
  const event = { eventId: `evt_${suffix}`, type: 'Completed', runId, workflowId: runId, channel: 'test', at: new Date().toISOString(), status: 'done', exitCode: 0, task: 'private prompt', cwd: '/private/path', output: 'private output' };
  try {
    await registerSubscriber({ subscriberId, runIds: [runId], eventTypes: ['Completed'], channels: ['test'], workflowIds: ['*'] });
    const first = await routeEvent(event);
    const duplicate = await routeEvent(event);
    assert.equal(first.delivered, 1);
    assert.equal(duplicate.duplicate, true);
    const claimed = await claimMailboxEvents({ subscriberId });
    assert.equal(claimed.events.length, 1);
    assert.equal(claimed.events[0].eventId, event.eventId);
    assert.equal('task' in claimed.events[0], false);
    assert.equal('cwd' in claimed.events[0], false);
    assert.equal('output' in claimed.events[0], false);
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

test('stale inflight callbacks can be requeued and acknowledged history can be pruned', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_requeue_${suffix}`;
  const eventId = `evt_requeue_${suffix}`;
  try {
    await registerSubscriber({ subscriberId, runIds: ['*'], eventTypes: ['Completed'], channels: ['*'], workflowIds: ['*'] });
    await routeEvent({ eventId, type: 'Completed', runId: `ter_${suffix}`, workflowId: 'w', channel: 'x', at: '2020-01-01T00:00:00.000Z' });
    await claimMailboxEvents({ subscriberId });
    // This subscriber is a wildcard, so other concurrently-running test files may
    // also land real Completed events here; assert on our own event, not exact totals.
    assert.ok((await requeueInflightEvents({ subscriberId, olderThanMs: 0 })).requeued >= 1);
    const claimed = await claimMailboxEvents({ subscriberId });
    assert.ok(claimed.events.some((e) => e.eventId === eventId));
    await acknowledgeMailboxEvent({ subscriberId, eventId });
    const pruned = await pruneRouter({ acknowledgedOlderThanMs: 0, journalOlderThanMs: 0, subscriberIds: [subscriberId], eventIds: [eventId] });
    assert.ok(pruned.acknowledgedRemoved >= 1);
    assert.ok(pruned.journalRemoved >= 1);
  } finally {
    await rm(join(MAILBOXES_DIR, subscriberId), { recursive: true, force: true });
    await rm(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
    await rm(join(JOURNAL_DIR, `${eventId}.json`), { force: true });
  }
});

test('callback subscriptions default to terminal events rather than progress heartbeats', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_terminal_${suffix}`;
  const runId = `ter_terminal_${suffix}`;
  const progressId = `evt_progress_${suffix}`;
  const completedId = `evt_completed_${suffix}`;
  try {
    const subscription = await registerSubscriber({ subscriberId, runIds: [runId] });
    assert.deepEqual(subscription.eventTypes, ['Completed', 'Failed', 'TimedOut', 'Cancelled']);
    assert.equal((await routeEvent({ eventId: progressId, type: 'Progress', runId, workflowId: runId, channel: 'x', at: new Date().toISOString() })).delivered, 0);
    assert.equal((await routeEvent({ eventId: completedId, type: 'Completed', runId, workflowId: runId, channel: 'x', at: new Date().toISOString() })).delivered, 1);
  } finally {
    await unregisterSubscriber(subscriberId);
    await rm(join(JOURNAL_DIR, `${progressId}.json`), { force: true });
    await rm(join(JOURNAL_DIR, `${completedId}.json`), { force: true });
  }
});

test('unsubscribe removes subscriber metadata and its entire mailbox', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_remove_${suffix}`;
  const eventId = `evt_remove_${suffix}`;
  await registerSubscriber({ subscriberId, runIds: ['*'] });
  await routeEvent({ eventId, type: 'Completed', runId: `ter_${suffix}`, workflowId: 'w', channel: 'x', at: new Date().toISOString() });
  assert.equal((await getMailboxStatus(subscriberId)).pending, 1);
  await unregisterSubscriber(subscriberId);
  assert.equal(existsSync(join(SUBSCRIBERS_DIR, `${subscriberId}.json`)), false);
  assert.equal(existsSync(join(MAILBOXES_DIR, subscriberId)), false);
  await rm(join(JOURNAL_DIR, `${eventId}.json`), { force: true });
});

test('prune removes stale pending and inflight callbacks and expires empty subscribers', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_prune_${suffix}`;
  const pendingId = `evt_pending_${suffix}`;
  const inflightId = `evt_inflight_${suffix}`;
  try {
    await registerSubscriber({ subscriberId, runIds: ['*'], createdAt: '2020-01-01T00:00:00.000Z' });
    await routeEvent({ eventId: pendingId, type: 'Completed', runId: `ter_p_${suffix}`, workflowId: 'w', channel: 'x', at: '2020-01-01T00:00:00.000Z' });
    await routeEvent({ eventId: inflightId, type: 'Completed', runId: `ter_i_${suffix}`, workflowId: 'w', channel: 'x', at: '2020-01-01T00:00:00.000Z' });
    await claimMailboxEvents({ subscriberId, limit: 1 });
    const pruned = await pruneRouter({ callbackOlderThanMs: 0, subscriberOlderThanMs: 0, journalOlderThanMs: 0, subscriberIds: [subscriberId], eventIds: [pendingId, inflightId] });
    assert.equal(pruned.pendingRemoved, 1);
    assert.equal(pruned.inflightRemoved, 1);
    assert.equal(pruned.subscribersRemoved, 1);
    assert.equal(existsSync(join(MAILBOXES_DIR, subscriberId)), false);
  } finally {
    await unregisterSubscriber(subscriberId).catch(() => {});
    await rm(join(JOURNAL_DIR, `${pendingId}.json`), { force: true });
    await rm(join(JOURNAL_DIR, `${inflightId}.json`), { force: true });
  }
});

test('concrete subscriptions replay a terminal event that finished before subscribe', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_late_${suffix}`;
  const runId = `ter_late_${suffix}`;
  const eventId = `evt_late_${suffix}`;
  try {
    const routed = await routeEvent({ eventId, type: 'Completed', runId, workflowId: runId, channel: 'x', at: new Date().toISOString() });
    assert.equal(routed.delivered, 0);
    const subscription = await registerSubscriber({ subscriberId, runIds: [runId], eventTypes: ['Completed'], channels: ['*'], workflowIds: ['*'] });
    assert.equal(subscription.replayed, 1);
    const claimed = await claimMailboxEvents({ subscriberId });
    assert.deepEqual(claimed.events.map((event) => event.eventId), [eventId]);
    await acknowledgeMailboxEvent({ subscriberId, eventId });
    const registeredAgain = await registerSubscriber({ subscriberId, runIds: [runId], eventTypes: ['Completed'], channels: ['*'], workflowIds: ['*'] });
    assert.equal(registeredAgain.replayed, 0, 'acknowledged events must not be redelivered');
  } finally {
    await unregisterSubscriber(subscriberId).catch(() => {});
    await rm(join(JOURNAL_DIR, `${eventId}.json`), { force: true });
  }
});

test('new wildcard subscriptions do not replay unrelated historical terminal events', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_wild_late_${suffix}`;
  const eventId = `evt_wild_late_${suffix}`;
  try {
    await routeEvent({ eventId, type: 'Completed', runId: `ter_${suffix}`, workflowId: 'w', channel: 'x', at: '2020-01-01T00:00:00.000Z' });
    const subscription = await registerSubscriber({ subscriberId, runIds: ['*'], eventTypes: ['Completed'], channels: ['*'], workflowIds: ['*'] });
    assert.equal(subscription.replayed, 0);
    assert.equal((await claimMailboxEvents({ subscriberId })).events.length, 0);
  } finally {
    await unregisterSubscriber(subscriberId).catch(() => {});
    await rm(join(JOURNAL_DIR, `${eventId}.json`), { force: true });
  }
});

test('Pi wildcard run subscriptions do not receive unrelated callbacks', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const piSubscriberId = `pi-${suffix}`;
  const pullSubscriberId = `sub_pull_${suffix}`;
  const runId = `ter_${suffix}`;
  const eventId = `evt_pi_wild_${suffix}`;
  try {
    await registerSubscriber({ subscriberId: piSubscriberId, runIds: ['*'], eventTypes: ['Completed'], channels: ['*'], workflowIds: ['*'] });
    await registerSubscriber({ subscriberId: pullSubscriberId, runIds: ['*'], eventTypes: ['Completed'], channels: ['*'], workflowIds: ['*'] });
    const result = await routeEvent({ eventId, type: 'Completed', runId, workflowId: runId, channel: 'cloudflare', at: new Date().toISOString() });
    assert.equal(result.delivered, 1, 'only the non-Pi wildcard pull subscriber should receive the event');
    assert.equal((await getMailboxStatus(piSubscriberId)).pending, 0);
    assert.equal((await getMailboxStatus(pullSubscriberId)).pending, 1);
  } finally {
    await unregisterSubscriber(piSubscriberId).catch(() => {});
    await unregisterSubscriber(pullSubscriberId).catch(() => {});
    await rm(join(JOURNAL_DIR, `${eventId}.json`), { force: true });
  }
});

test('a subscriber owned by one run cannot be hijacked by another run', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_owned_${suffix}`;
  const ownerRunId = `ter_owner_${suffix}`;
  try {
    await registerSubscriber({ subscriberId, ownerRunId, runIds: [ownerRunId] });
    await assert.rejects(
      registerSubscriber({ subscriberId, ownerRunId: `ter_attacker_${suffix}`, runIds: ['*'] }),
      /subscriber is owned by another run/,
    );
    const stored = JSON.parse(await readFile(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), 'utf8'));
    assert.equal(stored.ownerRunId, ownerRunId);
    assert.deepEqual(stored.runIds, [ownerRunId]);
  } finally {
    await unregisterSubscriber(subscriberId).catch(() => {});
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
