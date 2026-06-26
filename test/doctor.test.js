import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { diagnoseTerrarium } from '../src/doctor.js';
import { LOG_DIR } from '../src/core.js';
import { JOURNAL_DIR, MAILBOXES_DIR, SUBSCRIBERS_DIR } from '../src/router.js';

test('doctor reports bounded operational diagnostics without process environments', async () => {
  const result = await diagnoseTerrarium();
  for (const field of ['homeWritable', 'logsWritable', 'workspaceWritable', 'routerWritable']) assert.equal(typeof result.checks[field], 'boolean');
  for (const field of ['activeRuns', 'orphanedRuns', 'needsAttentionRuns', 'groups', 'subscribers', 'malformedSubscribers', 'journalEvents', 'malformedJournalEvents', 'pendingCallbacks', 'malformedPendingCallbacks', 'inflightCallbacks', 'malformedInflightCallbacks', 'missingTerminalCallbacks', 'staleChildClaims']) assert.equal(typeof result.checks[field], 'number');
  assert.equal(JSON.stringify(result).includes('process.env'), false);
  assert.ok(Array.isArray(result.warnings));
});

test('doctor reports malformed router JSON without crashing', async () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const subscriber = `${SUBSCRIBERS_DIR}/doctor_bad_${suffix}.json`;
  const journal = `${JOURNAL_DIR}/doctor_bad_${suffix}.json`;
  await Promise.all([mkdir(SUBSCRIBERS_DIR, { recursive: true }), mkdir(JOURNAL_DIR, { recursive: true })]);
  await Promise.all([writeFile(subscriber, '{bad'), writeFile(journal, '{bad')]);
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.checks.malformedSubscribers >= 1);
    assert.ok(result.checks.malformedJournalEvents >= 1);
    assert.ok(result.warnings.some((warning) => warning.includes('malformed subscriber')));
    assert.ok(result.warnings.some((warning) => warning.includes('malformed callback journal')));
  } finally {
    await Promise.all([rm(subscriber, { force: true }), rm(journal, { force: true })]);
  }
});

test('doctor validates semantic records and malformed pending and inflight callbacks', async () => {
  const suffix = `${process.pid}_${Date.now()}_semantic`;
  const subscriberId = `doctor_semantic_${suffix}`;
  const subscriber = `${SUBSCRIBERS_DIR}/${subscriberId}.json`;
  const journal = `${JOURNAL_DIR}/evt_doctor_${suffix}.json`;
  const pendingDir = `${MAILBOXES_DIR}/${subscriberId}/pending`;
  const inflightDir = `${MAILBOXES_DIR}/${subscriberId}/inflight`;
  await Promise.all([mkdir(SUBSCRIBERS_DIR, { recursive: true }), mkdir(JOURNAL_DIR, { recursive: true }), mkdir(pendingDir, { recursive: true }), mkdir(inflightDir, { recursive: true })]);
  await Promise.all([
    writeFile(subscriber, JSON.stringify({ subscriberId, ownerRunId: 'invalid' })),
    writeFile(journal, JSON.stringify({ eventId: 'wrong', type: 'Completed', runId: 'ter_x' })),
    writeFile(`${pendingDir}/evt_pending.json`, '{bad'),
    writeFile(`${inflightDir}/evt_inflight.json`, JSON.stringify({ eventId: 'wrong', type: 'Completed', runId: 'ter_x' })),
  ]);
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.checks.malformedSubscribers >= 1);
    assert.ok(result.checks.malformedJournalEvents >= 1);
    assert.ok(result.checks.malformedPendingCallbacks >= 1);
    assert.ok(result.checks.malformedInflightCallbacks >= 1);
  } finally {
    await Promise.all([rm(subscriber, { force: true }), rm(journal, { force: true }), rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true })]);
  }
});

test('doctor rejects private fields in subscriber, journal, and mailbox records without leaking payloads', async () => {
  const suffix = `${process.pid}_${Date.now()}_private`;
  const subscriberId = `doctor_private_${suffix}`;
  const eventId = `evt_doctor_private_${suffix}`;
  const subscriber = `${SUBSCRIBERS_DIR}/${subscriberId}.json`;
  const journal = `${JOURNAL_DIR}/${eventId}.json`;
  const pendingDir = `${MAILBOXES_DIR}/${subscriberId}/pending`;
  const secret = `PRIVATE_PAYLOAD_${suffix}`;
  const event = { eventId, type: 'Completed', runId: `ter_${suffix}`, payload: secret };
  await Promise.all([mkdir(SUBSCRIBERS_DIR, { recursive: true }), mkdir(JOURNAL_DIR, { recursive: true }), mkdir(pendingDir, { recursive: true })]);
  await Promise.all([
    writeFile(subscriber, JSON.stringify({ subscriberId, ownerRunId: null, privateMetadata: secret })),
    writeFile(journal, JSON.stringify(event)),
    writeFile(`${pendingDir}/${eventId}.json`, JSON.stringify(event)),
  ]);
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.checks.malformedSubscribers >= 1);
    assert.ok(result.checks.malformedJournalEvents >= 1);
    assert.ok(result.checks.malformedPendingCallbacks >= 1);
    assert.ok(result.warnings.some((warning) => warning.includes('malformed subscriber')));
    assert.ok(result.warnings.some((warning) => warning.includes('malformed callback journal')));
    assert.ok(result.warnings.some((warning) => warning.includes('malformed pending callback')));
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes('privateMetadata'), false);
    assert.equal(JSON.stringify(result).includes('payload'), false);
  } finally {
    await Promise.all([rm(subscriber, { force: true }), rm(journal, { force: true }), rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true })]);
  }
});

test('doctor tolerates a child-claim path that is not a readable directory', async () => {
  const claimPath = `${LOG_DIR}/doctor-malformed.children`;
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(claimPath, 'not a directory');
  try {
    const result = await diagnoseTerrarium();
    assert.ok(Array.isArray(result.warnings));
    assert.equal(typeof result.checks.staleChildClaims, 'number');
  } finally {
    await rm(claimPath, { force: true });
  }
});
