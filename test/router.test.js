import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { JOURNAL_DIR, MAILBOXES_DIR, SUBSCRIBERS_DIR, acknowledgeMailboxEvent, claimMailboxEvents, getMailboxStatus, getSubscriber, pruneRouter, registerSubscriber, requeueInflightEvents, routeEvent, unregisterSubscriber } from '../src/router.js';

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
      /subscriber is owned by another run or controller/,
    );
    const stored = JSON.parse(await readFile(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), 'utf8'));
    assert.equal(stored.ownerRunId, ownerRunId);
    assert.deepEqual(stored.runIds, [ownerRunId]);
  } finally {
    await unregisterSubscriber(subscriberId, { ownerRunId }).catch(() => {});
  }
});

test('unowned controllers cannot adopt an owned subscriber or inspect and mutate its mailbox', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_private_${suffix}`;
  const ownerRunId = `ter_private_${suffix}`;
  const eventId = `evt_private_${suffix}`;
  try {
    await registerSubscriber({ subscriberId, ownerRunId, runIds: [ownerRunId] });
    await routeEvent({ eventId, type: 'Completed', runId: ownerRunId, workflowId: 'w', channel: 'x', at: new Date().toISOString() });
    await assert.rejects(registerSubscriber({ subscriberId, runIds: ['*'] }), /owned by another run or controller/);
    await assert.rejects(claimMailboxEvents({ subscriberId }), /access denied/);
    await assert.rejects(getMailboxStatus(subscriberId), /access denied/);
    await assert.rejects(requeueInflightEvents({ subscriberId, olderThanMs: 0 }), /access denied/);
    await assert.rejects(unregisterSubscriber(subscriberId), /access denied/);
    assert.equal((await getMailboxStatus(subscriberId, { ownerRunId })).pending, 1);
    const claimed = await claimMailboxEvents({ subscriberId, ownerRunId });
    assert.deepEqual(claimed.events.map((event) => event.eventId), [eventId]);
    await acknowledgeMailboxEvent({ subscriberId, eventId, ownerRunId });
  } finally {
    await unregisterSubscriber(subscriberId, { ownerRunId }).catch(() => {});
    await rm(join(JOURNAL_DIR, `${eventId}.json`), { force: true });
  }
});

test('malformed subscriber JSON fails closed with the stable validation error', async () => {
  const suffix = `${process.pid}_${Date.now()}_json`;
  const subscriberId = `sub_malformed_${suffix}`;
  await mkdir(SUBSCRIBERS_DIR, { recursive: true });
  try {
    await writeFile(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), '{bad');
    await assert.rejects(registerSubscriber({ subscriberId, ownerRunId: `ter_owner_${suffix}`, runIds: ['*'] }), /invalid callback subscriber record/);
    await assert.rejects(getMailboxStatus(subscriberId, { ownerRunId: `ter_owner_${suffix}` }), /invalid callback subscriber record/);
  } finally {
    await rm(join(MAILBOXES_DIR, subscriberId), { recursive: true, force: true });
    await rm(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
  }
});

test('malformed subscriber records cannot become controller-owned mailboxes', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_malformed_${suffix}`;
  await mkdir(SUBSCRIBERS_DIR, { recursive: true });
  try {
    await writeFile(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), JSON.stringify({ subscriberId, runIds: ['*'] }));
    await assert.rejects(registerSubscriber({ subscriberId, runIds: ['*'] }), /invalid callback subscriber record/);
    await assert.rejects(getMailboxStatus(subscriberId), /invalid callback subscriber record/);
  } finally {
    await rm(join(MAILBOXES_DIR, subscriberId), { recursive: true, force: true });
    await rm(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
  }
});

test('controller prune skips child-owned mailboxes', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_owned_prune_${suffix}`;
  const ownerRunId = `ter_owned_prune_${suffix}`;
  const eventId = `evt_owned_prune_${suffix}`;
  try {
    await registerSubscriber({ subscriberId, ownerRunId, runIds: [ownerRunId], createdAt: '2020-01-01T00:00:00.000Z' });
    await routeEvent({ eventId, type: 'Completed', runId: ownerRunId, at: '2020-01-01T00:00:00.000Z' });
    const pruned = await pruneRouter({ acknowledgedOlderThanMs: 0, callbackOlderThanMs: 0, subscriberOlderThanMs: 0, subscriberIds: [subscriberId], eventIds: [eventId] });
    assert.equal(pruned.pendingRemoved, 0);
    assert.equal(pruned.subscribersRemoved, 0);
    assert.equal((await getMailboxStatus(subscriberId, { ownerRunId })).pending, 1);
  } finally {
    await unregisterSubscriber(subscriberId, { ownerRunId }).catch(() => {});
    await rm(join(JOURNAL_DIR, `${eventId}.json`), { force: true });
  }
});

test('prune skips mismatched ownership without aborting later controller mailboxes', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const ownedId = `aaa_owned_${suffix}`;
  const controllerId = `zzz_controller_${suffix}`;
  const ownerRunId = `ter_owner_${suffix}`;
  const ownedEvent = `evt_owned_${suffix}`;
  const controllerEvent = `evt_controller_${suffix}`;
  try {
    await registerSubscriber({ subscriberId: ownedId, ownerRunId, runIds: [ownerRunId], createdAt: '2020-01-01T00:00:00.000Z' });
    await registerSubscriber({ subscriberId: controllerId, runIds: ['*'], createdAt: '2020-01-01T00:00:00.000Z' });
    await routeEvent({ eventId: ownedEvent, type: 'Completed', runId: ownerRunId, at: '2020-01-01T00:00:00.000Z' });
    await routeEvent({ eventId: controllerEvent, type: 'Completed', runId: `ter_controller_${suffix}`, at: '2020-01-01T00:00:00.000Z' });
    const result = await pruneRouter({ callbackOlderThanMs: 0, subscriberOlderThanMs: 0, subscriberIds: [ownedId, controllerId], eventIds: [ownedEvent, controllerEvent] });
    assert.ok(result.pendingRemoved >= 1, 'the controller mailbox must still be pruned');
    assert.equal(result.subscribersRemoved, 1);
    assert.equal((await getMailboxStatus(ownedId, { ownerRunId })).pending, 1);
  } finally {
    await unregisterSubscriber(ownedId, { ownerRunId }).catch(() => {});
    await unregisterSubscriber(controllerId).catch(() => {});
    await rm(join(JOURNAL_DIR, `${ownedEvent}.json`), { force: true });
    await rm(join(JOURNAL_DIR, `${controllerEvent}.json`), { force: true });
  }
});

test('malformed journal timestamps are retained rather than treated as stale', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const eventId = `evt_bad_time_${suffix}`;
  const path = join(JOURNAL_DIR, `${eventId}.json`);
  await mkdir(JOURNAL_DIR, { recursive: true });
  await writeFile(path, JSON.stringify({ eventId, type: 'Completed', runId: `ter_${suffix}`, at: 'not-a-date' }));
  try {
    const result = await pruneRouter({ journalOlderThanMs: 0, eventIds: [eventId] });
    assert.equal(result.journalRemoved, 0);
    assert.equal(existsSync(path), true);
  } finally {
    await rm(path, { force: true });
  }
});

test('mailbox status excludes malformed pending and inflight records and prune retains them', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_malformed_mailbox_${suffix}`;
  const pendingDir = join(MAILBOXES_DIR, subscriberId, 'pending');
  const inflightDir = join(MAILBOXES_DIR, subscriberId, 'inflight');
  const badPending = join(pendingDir, `evt_bad_pending_${suffix}.json`);
  const badInflight = join(inflightDir, `evt_bad_inflight_${suffix}.json`);
  try {
    await registerSubscriber({ subscriberId, runIds: ['*'] });
    await writeFile(badPending, '{bad');
    await writeFile(badInflight, JSON.stringify({ eventId: 'wrong', type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z' }));
    assert.deepEqual(await getMailboxStatus(subscriberId), { subscriberId, pending: 0, inflight: 0, acknowledged: 0 });
    const result = await pruneRouter({ callbackOlderThanMs: 0, subscriberIds: [subscriberId] });
    assert.equal(result.pendingRemoved, 0);
    assert.equal(result.inflightRemoved, 0);
    assert.equal(existsSync(badPending), true);
    assert.equal(existsSync(badInflight), true);
  } finally {
    await unregisterSubscriber(subscriberId).catch(() => {});
  }
});

test('claim rejects structurally valid mailbox payloads containing non-allowlisted private fields', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_private_payload_${suffix}`;
  const eventId = `evt_private_payload_${suffix}`;
  const pending = join(MAILBOXES_DIR, subscriberId, 'pending', `${eventId}.json`);
  try {
    await registerSubscriber({ subscriberId, runIds: ['*'] });
    await writeFile(pending, JSON.stringify({ eventId, type: 'Completed', runId: `ter_${suffix}`, at: new Date().toISOString(), task: 'secret prompt', logPath: '/private/log' }));
    assert.deepEqual((await claimMailboxEvents({ subscriberId })).events, []);
    assert.equal(existsSync(pending), true, 'malformed payload remains available for diagnosis');
    assert.equal((await getMailboxStatus(subscriberId)).pending, 0);
    const result = await pruneRouter({ callbackOlderThanMs: 0, subscriberIds: [subscriberId], eventIds: [eventId] });
    assert.equal(result.pendingRemoved, 0);
    assert.equal(existsSync(pending), true);
  } finally {
    await unregisterSubscriber(subscriberId).catch(() => {});
  }
});

test('claimed callback validation accepts only claimedAt beyond the routed allowlist', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_claimed_allowlist_${suffix}`;
  const eventId = `evt_claimed_allowlist_${suffix}`;
  const inflight = join(MAILBOXES_DIR, subscriberId, 'inflight', `${eventId}.json`);
  try {
    await registerSubscriber({ subscriberId, runIds: ['*'] });
    await writeFile(inflight, JSON.stringify({ eventId, type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '2020-01-01T00:00:00.000Z', privateMetadata: 'secret' }));
    assert.equal((await requeueInflightEvents({ subscriberId, olderThanMs: 0 })).requeued, 0);
    assert.equal((await pruneRouter({ callbackOlderThanMs: 0, subscriberIds: [subscriberId], eventIds: [eventId] })).inflightRemoved, 0);
    assert.equal(existsSync(inflight), true);
    await writeFile(inflight, JSON.stringify({ eventId, type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '2020-01-01T00:00:00.000Z' }));
    assert.equal((await requeueInflightEvents({ subscriberId, olderThanMs: 0 })).requeued, 1);
  } finally {
    await unregisterSubscriber(subscriberId).catch(() => {});
  }
});

test('subscriber records with private fields fail closed before owner checks', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_private_record_${suffix}`;
  await mkdir(SUBSCRIBERS_DIR, { recursive: true });
  try {
    await writeFile(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), JSON.stringify({ subscriberId, ownerRunId: `ter_owner_${suffix}`, runIds: ['*'], privateMetadata: 'secret' }));
    await assert.rejects(getSubscriber(subscriberId), /invalid callback subscriber record/);
    await assert.rejects(claimMailboxEvents({ subscriberId, ownerRunId: `ter_owner_${suffix}` }), /invalid callback subscriber record/);
  } finally {
    await rm(join(MAILBOXES_DIR, subscriberId), { recursive: true, force: true });
    await rm(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
  }
});

test('subscriber IDs cannot traverse router storage paths', async () => {
  for (const subscriberId of ['../victim', '..', 'sub/name', 'sub\\name', 'sub%2fescape']) {
    await assert.rejects(registerSubscriber({ subscriberId, runIds: ['*'] }), /invalid subscriber id/);
    await assert.rejects(getMailboxStatus(subscriberId), /invalid subscriber id/);
  }
});

test('child-owned prune requires the exact owner and cannot cross subscriber ownership', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const subscriberId = `sub_owner_prune_${suffix}`;
  const ownerRunId = `ter_owner_prune_${suffix}`;
  const eventId = `evt_owner_prune_${suffix}`;
  try {
    await registerSubscriber({ subscriberId, ownerRunId, runIds: [ownerRunId] });
    await routeEvent({ eventId, type: 'Completed', runId: ownerRunId, at: '2020-01-01T00:00:00.000Z' });
    const mismatch = await pruneRouter({ ownerRunId: `ter_attacker_${suffix}`, callbackOlderThanMs: 0, subscriberIds: [subscriberId], eventIds: [eventId] });
    assert.equal(mismatch.pendingRemoved, 0);
    assert.equal((await getMailboxStatus(subscriberId, { ownerRunId })).pending, 1);
    const owned = await pruneRouter({ ownerRunId, callbackOlderThanMs: 0, subscriberIds: [subscriberId], eventIds: [eventId] });
    assert.equal(owned.pendingRemoved, 1);
  } finally {
    await unregisterSubscriber(subscriberId, { ownerRunId }).catch(() => {});
    await rm(join(JOURNAL_DIR, `${eventId}.json`), { force: true });
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
