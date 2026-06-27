import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { diagnoseTerrarium } from '../src/doctor.js';
import { BATCH_API_VERSION, MCP_SCHEMA_VERSION, TERRARIUM_API_VERSION } from '../src/versions.js';
import { LOG_DIR } from '../src/core.js';
import { JOURNAL_DIR, MAILBOXES_DIR, SUBSCRIBERS_DIR } from '../src/router.js';

test('doctor reports bounded operational diagnostics without process environments', async () => {
  const result = await diagnoseTerrarium();
  assert.equal(result.apiVersion, TERRARIUM_API_VERSION);
  assert.equal(result.schemaVersion, MCP_SCHEMA_VERSION);
  assert.equal(result.batchApiVersion, BATCH_API_VERSION);
  assert.ok(result.batchSupportedOptions.includes('cleanupTimeoutMs'));
  for (const field of ['homeWritable', 'logsWritable', 'workspaceWritable', 'routerWritable']) assert.equal(typeof result.checks[field], 'boolean');
  for (const field of ['activeRuns', 'orphanedRuns', 'needsAttentionRuns', 'groups', 'subscribers', 'malformedSubscribers', 'journalEvents', 'malformedJournalEvents', 'pendingCallbacks', 'malformedPendingCallbacks', 'inflightCallbacks', 'malformedInflightCallbacks', 'acknowledgedCallbacks', 'malformedAcknowledgedCallbacks', 'staleInflightCallbacks', 'routerRepairCandidates', 'missingTerminalCallbacks', 'staleChildClaims']) assert.equal(typeof result.checks[field], 'number');
  assert.equal(JSON.stringify(result).includes('process.env'), false);
  assert.ok(Array.isArray(result.warnings));
  assert.ok(Array.isArray(result.details.activeRunIds));
  assert.ok(Array.isArray(result.details.orphanedRunIds));
  assert.ok(Array.isArray(result.details.needsAttentionRunIds));
  assert.ok(Array.isArray(result.details.missingTerminalCallbackRunIds));
  assert.ok(Array.isArray(result.details.staleChildClaims));
  assert.ok(Array.isArray(result.repairPlan));
  for (const step of result.repairPlan) {
    assert.equal(typeof step.kind, 'string');
    assert.equal(typeof step.action, 'string');
    assert.equal(typeof step.reason, 'string');
  }
  // repairPlanSummary is an at-a-glance triage rollup derived from repairPlan.
  assert.equal(typeof result.repairPlanSummary, 'object');
  assert.equal(result.repairPlanSummary.total, result.repairPlan.length);
  assert.equal(typeof result.repairPlanSummary.actionable, 'number');
  assert.ok(result.repairPlanSummary.actionable <= result.repairPlanSummary.total);
  assert.equal(typeof result.repairPlanSummary.byAction, 'object');
  const summedByAction = Object.values(result.repairPlanSummary.byAction).reduce((a, b) => a + b, 0);
  assert.equal(summedByAction, result.repairPlan.length);
  // Steps carrying a tool are exactly the ones counted as mechanically actionable.
  assert.equal(result.repairPlan.filter((step) => step.tool).length, result.repairPlanSummary.actionable);
});

test('doctor derives a recover-oriented repair plan from detected reconstruction signals', async () => {
  const suffix = `${process.pid}_${Date.now()}_repairplan`;
  const subscriberId = `doctor_repair_${suffix}`;
  const inflightDir = `${MAILBOXES_DIR}/${subscriberId}/inflight`;
  const inflightId = `evt_stale_${suffix}`;
  await mkdir(inflightDir, { recursive: true });
  // A valid claimed event whose claim is older than the staleness window.
  await writeFile(`${inflightDir}/${inflightId}.json`, JSON.stringify({ eventId: inflightId, type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '2020-01-01T00:00:00.000Z' }));
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.checks.staleInflightCallbacks >= 1);
    const stale = result.repairPlan.find((step) => step.kind === 'staleInflightCallback');
    assert.ok(stale, 'expected a staleInflightCallback repair step');
    assert.equal(stale.action, 'requeue');
    assert.equal(stale.tool, 'terrarium_callbacks');
    assert.equal(stale.args.action, 'requeue');
    // Repair plan never leaks raw payloads or private fields.
    assert.equal(JSON.stringify(result.repairPlan).includes('claimedAt'), false);
  } finally {
    await rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true });
  }
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

test('doctor applies callback validation for pending and inflight states', async () => {
  const suffix = `${process.pid}_${Date.now()}_state`;
  const subscriberId = `doctor_state_${suffix}`;
  const pendingDir = `${MAILBOXES_DIR}/${subscriberId}/pending`;
  const inflightDir = `${MAILBOXES_DIR}/${subscriberId}/inflight`;
  const pendingId = `evt_pending_${suffix}`;
  const inflightId = `evt_inflight_${suffix}`;
  const base = { type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z' };
  await Promise.all([mkdir(pendingDir, { recursive: true }), mkdir(inflightDir, { recursive: true })]);
  await Promise.all([
    writeFile(`${pendingDir}/${pendingId}.json`, JSON.stringify({ ...base, eventId: pendingId, claimedAt: '2020-01-01T00:00:00.000Z' })),
    writeFile(`${inflightDir}/${inflightId}.json`, JSON.stringify({ ...base, eventId: inflightId })),
  ]);
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.checks.malformedPendingCallbacks >= 1);
    assert.ok(result.checks.malformedInflightCallbacks >= 1);
    assert.ok(result.warnings.some((warning) => warning.includes('malformed pending callback')));
    assert.ok(result.warnings.some((warning) => warning.includes('malformed inflight callback')));
  } finally {
    await rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true });
  }
});

test('doctor counts valid state-specific callbacks', async () => {
  const suffix = `${process.pid}_${Date.now()}_valid_state`;
  const subscriberId = `doctor_valid_state_${suffix}`;
  const pendingDir = `${MAILBOXES_DIR}/${subscriberId}/pending`;
  const inflightDir = `${MAILBOXES_DIR}/${subscriberId}/inflight`;
  const pendingId = `evt_pending_valid_${suffix}`;
  const inflightId = `evt_inflight_valid_${suffix}`;
  const base = { type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z' };
  await Promise.all([mkdir(pendingDir, { recursive: true }), mkdir(inflightDir, { recursive: true })]);
  await Promise.all([
    writeFile(`${pendingDir}/${pendingId}.json`, JSON.stringify({ ...base, eventId: pendingId })),
    writeFile(`${inflightDir}/${inflightId}.json`, JSON.stringify({ ...base, eventId: inflightId, claimedAt: '2020-01-01T00:00:00.000Z' })),
  ]);
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.checks.pendingCallbacks >= 1);
    assert.ok(result.checks.inflightCallbacks >= 1);
  } finally {
    await rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true });
  }
});

test('doctor mirrors router validation for acknowledged, stale inflight, and repair candidates', async () => {
  const suffix = `${process.pid}_${Date.now()}_repair`;
  const subscriberId = `doctor_repair_${suffix}`;
  const root = `${MAILBOXES_DIR}/${subscriberId}`;
  const staleId = `evt_stale_${suffix}`;
  const ackedId = `evt_acked_${suffix}`;
  const privateId = `evt_private_acked_${suffix}`;
  const base = { type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '2020-01-01T00:00:00.000Z' };
  await Promise.all([mkdir(`${root}/inflight`, { recursive: true }), mkdir(`${root}/acked`, { recursive: true })]);
  await Promise.all([
    writeFile(`${root}/inflight/${staleId}.json`, JSON.stringify({ ...base, eventId: staleId })),
    writeFile(`${root}/acked/${ackedId}.json`, JSON.stringify({ ...base, eventId: ackedId })),
    writeFile(`${root}/acked/${privateId}.json`, JSON.stringify({ ...base, eventId: privateId, privateMetadata: 'secret' })),
  ]);
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.checks.acknowledgedCallbacks >= 1);
    assert.ok(result.checks.malformedAcknowledgedCallbacks >= 1);
    assert.ok(result.checks.staleInflightCallbacks >= 1);
    assert.ok(result.checks.routerRepairCandidates >= result.checks.staleInflightCallbacks);
    assert.ok(result.warnings.some((warning) => warning.includes('malformed acknowledged callback')));
    assert.ok(result.warnings.some((warning) => warning.includes('repair candidates for requeue')));
    assert.equal(JSON.stringify(result).includes('privateMetadata'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor repair candidates include stale inflight and malformed retained acked records', async () => {
  const suffix = `${process.pid}_${Date.now()}_candidate_semantics`;
  const subscriberId = `doctor_candidate_${suffix}`;
  const root = `${MAILBOXES_DIR}/${subscriberId}`;
  const staleId = `evt_stale_candidate_${suffix}`;
  const malformedAckedId = `evt_malformed_acked_${suffix}`;
  const baseline = await diagnoseTerrarium();
  const base = { type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '2020-01-01T00:00:00.000Z' };
  await Promise.all([mkdir(`${root}/inflight`, { recursive: true }), mkdir(`${root}/acked`, { recursive: true })]);
  await Promise.all([
    writeFile(`${root}/inflight/${staleId}.json`, JSON.stringify({ ...base, eventId: staleId })),
    writeFile(`${root}/acked/${malformedAckedId}.json`, JSON.stringify({ ...base, eventId: malformedAckedId, privateMetadata: 'retained' })),
  ]);
  try {
    const result = await diagnoseTerrarium();
    assert.equal(result.checks.staleInflightCallbacks, baseline.checks.staleInflightCallbacks + 1);
    assert.equal(result.checks.malformedAcknowledgedCallbacks, baseline.checks.malformedAcknowledgedCallbacks + 1);
    assert.ok(result.checks.routerRepairCandidates >= baseline.checks.routerRepairCandidates + 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('doctor rejects malformed timestamps in every router state and aligns repair candidates', async () => {
  const suffix = `${process.pid}_${Date.now()}_timestamps`;
  const subscriberId = `doctor_timestamps_${suffix}`;
  const root = `${MAILBOXES_DIR}/${subscriberId}`;
  const subscriber = `${SUBSCRIBERS_DIR}/${subscriberId}.json`;
  const journalId = `evt_journal_timestamp_${suffix}`;
  const journal = `${JOURNAL_DIR}/${journalId}.json`;
  const states = ['pending', 'inflight', 'acked'];
  const baseline = await diagnoseTerrarium();
  await Promise.all([
    mkdir(SUBSCRIBERS_DIR, { recursive: true }),
    mkdir(JOURNAL_DIR, { recursive: true }),
    ...states.map((state) => mkdir(`${root}/${state}`, { recursive: true })),
  ]);
  await writeFile(subscriber, JSON.stringify({ subscriberId, ownerRunId: null, createdAt: 'not-a-date', updatedAt: 'not-a-date' }));
  await writeFile(journal, JSON.stringify({ eventId: journalId, type: 'Completed', runId: `ter_${suffix}`, at: 'not-a-date' }));
  for (const state of states) {
    const eventId = `evt_${state}_timestamp_${suffix}`;
    const event = { eventId, type: 'Completed', runId: `ter_${suffix}`, at: 'not-a-date' };
    if (state !== 'pending') event.claimedAt = '2020-01-01T00:00:00.000Z';
    await writeFile(`${root}/${state}/${eventId}.json`, JSON.stringify(event));
  }
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.checks.malformedSubscribers >= baseline.checks.malformedSubscribers + 1);
    assert.ok(result.checks.malformedJournalEvents >= baseline.checks.malformedJournalEvents + 1);
    assert.ok(result.checks.malformedPendingCallbacks >= baseline.checks.malformedPendingCallbacks + 1);
    assert.ok(result.checks.malformedInflightCallbacks >= baseline.checks.malformedInflightCallbacks + 1);
    assert.ok(result.checks.malformedAcknowledgedCallbacks >= baseline.checks.malformedAcknowledgedCallbacks + 1);
    assert.ok(result.checks.routerRepairCandidates >= baseline.checks.routerRepairCandidates + 3);
  } finally {
    await Promise.all([rm(subscriber, { force: true }), rm(journal, { force: true }), rm(root, { recursive: true, force: true })]);
  }
});

test('doctor rejects Date.parse-only timestamps, malformed subscriber ids, and does not stale future claims', async () => {
  const suffix = `${process.pid}_${Date.now()}_timestamp_edges`;
  const subscriberId = `doctor_timestamp_edges_${suffix}`;
  const malformedSubscriberId = `doctor.timestamp_edges_${suffix}`;
  const root = `${MAILBOXES_DIR}/${subscriberId}`;
  const weirdId = `evt_weird_${suffix}`;
  const futureId = `evt_future_${suffix}`;
  const baseline = await diagnoseTerrarium();
  await Promise.all([
    mkdir(SUBSCRIBERS_DIR, { recursive: true }),
    mkdir(`${root}/inflight`, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(`${SUBSCRIBERS_DIR}/${malformedSubscriberId}.json`, JSON.stringify({ subscriberId: malformedSubscriberId, ownerRunId: null, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })),
    writeFile(`${root}/inflight/${weirdId}.json`, JSON.stringify({ eventId: weirdId, type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '01/01/2020' })),
    writeFile(`${root}/inflight/${futureId}.json`, JSON.stringify({ eventId: futureId, type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '2999-01-01T00:00:00.000Z' })),
  ]);
  try {
    const result = await diagnoseTerrarium();
    assert.equal(result.checks.malformedSubscribers, baseline.checks.malformedSubscribers + 1);
    assert.equal(result.checks.malformedInflightCallbacks, baseline.checks.malformedInflightCallbacks + 1);
    assert.equal(result.checks.inflightCallbacks, baseline.checks.inflightCallbacks + 1);
    assert.equal(result.checks.staleInflightCallbacks, baseline.checks.staleInflightCallbacks);
  } finally {
    await Promise.all([
      rm(`${SUBSCRIBERS_DIR}/${malformedSubscriberId}.json`, { force: true }),
      rm(root, { recursive: true, force: true }),
    ]);
  }
});

test('doctor rejects malformed event ids and counts stale malformed child claims', async () => {
  const suffix = `${process.pid}_${Date.now()}_claims`;
  const claimsDir = `${LOG_DIR}/doctor-${suffix}.children`;
  const malformedEventId = `evt.malformed.${suffix}`;
  const journal = `${JOURNAL_DIR}/${malformedEventId}.json`;
  const baseline = await diagnoseTerrarium();
  await Promise.all([mkdir(claimsDir, { recursive: true }), mkdir(JOURNAL_DIR, { recursive: true })]);
  await Promise.all([
    writeFile(`${claimsDir}/empty`, ''),
    writeFile(`${claimsDir}/missing`, `ter_missing_${suffix}`),
    writeFile(`${claimsDir}/malformed`, `../ter_${suffix}`),
    writeFile(journal, JSON.stringify({ eventId: malformedEventId, type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z' })),
  ]);
  try {
    const result = await diagnoseTerrarium();
    assert.ok(result.checks.malformedJournalEvents >= baseline.checks.malformedJournalEvents + 1);
    assert.ok(result.checks.staleChildClaims >= baseline.checks.staleChildClaims + 3);
    const claimFiles = result.details.staleChildClaims.map((claim) => claim.claimFile);
    assert.ok(claimFiles.includes(`${claimsDir}/empty`));
    assert.ok(claimFiles.includes(`${claimsDir}/missing`));
    assert.ok(claimFiles.includes(`${claimsDir}/malformed`));
    assert.ok(result.details.staleChildClaims.some((claim) => claim.childRunId === `ter_missing_${suffix}`));
    assert.ok(result.warnings.some((warning) => warning.includes('stale child-slot claim')));
  } finally {
    await Promise.all([rm(claimsDir, { recursive: true, force: true }), rm(journal, { force: true })]);
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
