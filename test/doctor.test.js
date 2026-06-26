import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { diagnoseTerrarium } from '../src/doctor.js';
import { LOG_DIR } from '../src/core.js';
import { JOURNAL_DIR, SUBSCRIBERS_DIR } from '../src/router.js';

test('doctor reports bounded operational diagnostics without process environments', async () => {
  const result = await diagnoseTerrarium();
  for (const field of ['homeWritable', 'logsWritable', 'workspaceWritable', 'routerWritable']) assert.equal(typeof result.checks[field], 'boolean');
  for (const field of ['activeRuns', 'orphanedRuns', 'needsAttentionRuns', 'groups', 'subscribers', 'malformedSubscribers', 'journalEvents', 'malformedJournalEvents', 'pendingCallbacks', 'inflightCallbacks', 'missingTerminalCallbacks', 'staleChildClaims']) assert.equal(typeof result.checks[field], 'number');
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
