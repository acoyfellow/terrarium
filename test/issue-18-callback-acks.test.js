import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { diagnoseTerrarium } from '../src/doctor.js';
import { LOG_DIR } from '../src/core.js';
import { JOURNAL_DIR, MAILBOXES_DIR, claimMailboxEvents, registerSubscriber, routeEvent, unregisterSubscriber } from '../src/router.js';

function terminalEvent(runId, status) {
  const type = status === 'done' ? 'Completed' : status === 'cancelled' ? 'Cancelled' : 'Failed';
  return { type, eventId: `evt_${runId}_${type}`, runId, parentRunId: null, taskFingerprint: 'f'.repeat(24), workflowId: runId, sessionId: null, channel: 'issue18', at: new Date().toISOString(), status, ok: status === 'done', exitCode: status === 'done' ? 0 : 1, signal: null, dryRun: false };
}

test('issue 18: a malformed acknowledgement does not hide the terminal callback from its subscriber', async () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const runId = `ter_issue18_${suffix}`;
  const subscriberId = `issue18_${suffix}`;
  const event = terminalEvent(runId, 'inconclusive');
  await registerSubscriber({ subscriberId, runIds: [runId] });
  const acked = `${MAILBOXES_DIR}/${subscriberId}/acked`;
  await mkdir(acked, { recursive: true });
  await writeFile(`${acked}/${event.eventId}.json`, JSON.stringify(event));
  try {
    await routeEvent(event);
    const claimed = await claimMailboxEvents({ subscriberId, limit: 10 });
    assert.deepEqual(claimed.events.map((e) => e.runId), [runId], 'the inconclusive terminal callback is still claimable');
  } finally {
    await unregisterSubscriber(subscriberId).catch(() => {});
    await rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true });
    await rm(`${JOURNAL_DIR}/${event.eventId}.json`, { force: true });
  }
});

test('issue 18: doctor counts a terminal run whose only acknowledgement is malformed as missing', async () => {
  const suffix = `${process.pid}_${Date.now()}_doc`;
  const runId = `ter_issue18doc_${suffix}`;
  const subscriberId = `issue18doc_${suffix}`;
  const event = terminalEvent(runId, 'failed');
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(`${LOG_DIR}/${runId}.json`, JSON.stringify({ runId, status: 'inconclusive', ok: false }));
  await mkdir(JOURNAL_DIR, { recursive: true });
  await writeFile(`${JOURNAL_DIR}/${event.eventId}.json`, JSON.stringify(event));
  const acked = `${MAILBOXES_DIR}/${subscriberId}/acked`;
  await mkdir(acked, { recursive: true });
  await writeFile(`${acked}/${event.eventId}.json`, JSON.stringify(event));
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.details.missingTerminalCallbackRunIds.includes(runId), 'run with only a malformed ack is reported missing');
    assert.ok(result.checks.missingTerminalCallbacks >= 1);
  } finally {
    await rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true });
    await rm(`${JOURNAL_DIR}/${event.eventId}.json`, { force: true });
    await rm(`${LOG_DIR}/${runId}.json`, { force: true });
  }
});
