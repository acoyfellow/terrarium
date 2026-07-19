import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { diagnoseTerrarium } from '../src/doctor.js';
import { BATCH_API_VERSION, MCP_SCHEMA_VERSION, TERRARIUM_API_VERSION } from '../src/versions.js';
import { readFile } from 'node:fs/promises';
import { LOG_DIR, WORKSPACE_DIR, CONFIG_PATH } from '../src/core.js';
import { JOURNAL_DIR, MAILBOXES_DIR, SUBSCRIBERS_DIR } from '../src/router.js';

test('doctor reports workspace footprint and flags a leaked terminal-run workspace', async () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const leakedRun = `ter_wsleak_${suffix}`;   // terminal run, workspace survived, no keepWorkspace => leak
  const keptRun = `ter_wskeep_${suffix}`;      // terminal run but keepWorkspace:true => NOT a leak
  const liveRun = `ter_wslive_${suffix}`;      // still running => NOT a leak
  const wsPaths = [`${WORKSPACE_DIR}/${leakedRun}-repo`, `${WORKSPACE_DIR}/${keptRun}-repo`, `${WORKSPACE_DIR}/${liveRun}-repo`];
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await Promise.all(wsPaths.map((p) => mkdir(p, { recursive: true })));
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(`${LOG_DIR}/${leakedRun}.json`, JSON.stringify({ runId: leakedRun, status: 'done', ok: true }));
  await writeFile(`${LOG_DIR}/${keptRun}.json`, JSON.stringify({ runId: keptRun, status: 'done', ok: true, keepWorkspace: true }));
  await writeFile(`${LOG_DIR}/${liveRun}.json`, JSON.stringify({ runId: liveRun, status: 'running' }));
  try {
    const r = await diagnoseTerrarium();
    assert.ok(r.checks.workspaceDirs >= 3, `workspaceDirs counts dirs (got ${r.checks.workspaceDirs})`);
    assert.equal(typeof r.checks.workspaceBytes, 'number');
    assert.ok(r.checks.leakedWorkspaces >= 1, `at least the leaked terminal workspace is flagged (got ${r.checks.leakedWorkspaces})`);
    assert.ok(r.warnings.some((w) => /workspace\(s\) survived a terminal run/.test(w)), 'emits a leaked-workspace warning');
  } finally {
    await Promise.all([...wsPaths.map((p) => rm(p, { recursive: true, force: true })),
      rm(`${LOG_DIR}/${leakedRun}.json`, { force: true }), rm(`${LOG_DIR}/${keptRun}.json`, { force: true }), rm(`${LOG_DIR}/${liveRun}.json`, { force: true })]);
  }
});

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
  assert.ok(Array.isArray(result.details.staleInflightCallbackSubscriberIds));
  assert.ok(Array.isArray(result.details.staleChildClaims));
  // Every mechanically-actionable step must carry runnable args, never a bare
  // tool handle an agent cannot dispatch.
  for (const step of result.repairPlan) {
    if (step.tool) assert.equal(typeof step.args, 'object');
  }
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

test('doctor flags stale-cloud-env: cloud configured but no pulse token (undeliverable background callbacks)', async () => {
  const saved = {
    url: process.env.TERRARIUM_URL, tok: process.env.TERRARIUM_CONTROL_TOKEN,
    tokFile: process.env.TERRARIUM_TOKEN_FILE, pulse: process.env.TERRARIUM_PULSE_TOKEN,
    pulseFile: process.env.TERRARIUM_PULSE_TOKEN_FILE,
  };
  try {
    // Cloud on (url + control token), pulse OFF: the dangerous combination.
    process.env.TERRARIUM_URL = 'https://terrarium.example.dev';
    process.env.TERRARIUM_CONTROL_TOKEN = 'ctrl-token';
    delete process.env.TERRARIUM_TOKEN_FILE;
    delete process.env.TERRARIUM_PULSE_TOKEN;
    delete process.env.TERRARIUM_PULSE_TOKEN_FILE;
    const bad = await diagnoseTerrarium();
    assert.equal(bad.checks.cloudConfigured, true);
    assert.equal(bad.checks.pulseConfigured, false);
    assert.equal(bad.checks.cloudCallbacksUndeliverable, true);
    assert.ok(bad.warnings.some((w) => /pulse token/i.test(w) && /reload/i.test(w)));

    // Add the pulse token: the warning clears.
    process.env.TERRARIUM_PULSE_TOKEN = 'pulse-token';
    const good = await diagnoseTerrarium();
    assert.equal(good.checks.cloudConfigured, true);
    assert.equal(good.checks.pulseConfigured, true);
    assert.equal(good.checks.cloudCallbacksUndeliverable, false);
    assert.equal(good.warnings.some((w) => /pulse token/i.test(w)), false);

    // Pure-local (no cloud): never flagged.
    delete process.env.TERRARIUM_URL;
    delete process.env.TERRARIUM_CONTROL_TOKEN;
    delete process.env.TERRARIUM_PULSE_TOKEN;
    const local = await diagnoseTerrarium();
    assert.equal(local.checks.cloudConfigured, false);
    assert.equal(local.checks.cloudCallbacksUndeliverable, false);
  } finally {
    for (const [k, v] of [['TERRARIUM_URL', saved.url], ['TERRARIUM_CONTROL_TOKEN', saved.tok], ['TERRARIUM_TOKEN_FILE', saved.tokFile], ['TERRARIUM_PULSE_TOKEN', saved.pulse], ['TERRARIUM_PULSE_TOKEN_FILE', saved.pulseFile]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('doctor flags stale-MCP-process-env: config records cloudUrl but process env is stale (/reload)', async () => {
  const savedUrl = process.env.TERRARIUM_URL;
  let savedConfig; try { savedConfig = await readFile(CONFIG_PATH, 'utf8'); } catch { savedConfig = null; }
  try {
    // Persist a cloud URL into config.json (operator configured cloud)...
    await writeFile(CONFIG_PATH, JSON.stringify({ cloudUrl: 'https://terrarium.example.dev' }));
    // ...but the running MCP process env does NOT reflect it (stale process).
    delete process.env.TERRARIUM_URL;
    const stale = await diagnoseTerrarium();
    assert.equal(stale.checks.staleCloudEnv, true);
    assert.equal(stale.checks.configuredCloudUrl, 'https://terrarium.example.dev');
    assert.equal(stale.checks.processCloudUrl, null);
    assert.ok(stale.warnings.some((w) => /stale mcp process env/i.test(w) && /reload/i.test(w)));

    // Process env now matches the persisted config: the warning clears.
    process.env.TERRARIUM_URL = 'https://terrarium.example.dev/';
    const fresh = await diagnoseTerrarium();
    assert.equal(fresh.checks.staleCloudEnv, false, 'trailing slash normalized, env matches config');
    assert.equal(fresh.warnings.some((w) => /stale mcp process env/i.test(w)), false);

    // Process env points at a DIFFERENT cloud than config: still stale.
    process.env.TERRARIUM_URL = 'https://other.example.dev';
    const drift = await diagnoseTerrarium();
    assert.equal(drift.checks.staleCloudEnv, true);
    assert.equal(drift.checks.processCloudUrl, 'https://other.example.dev');

    // No cloudUrl persisted: never flagged (env-only cloud is fine).
    await writeFile(CONFIG_PATH, JSON.stringify({ defaultModel: 'x' }));
    process.env.TERRARIUM_URL = 'https://terrarium.example.dev';
    const noConfig = await diagnoseTerrarium();
    assert.equal(noConfig.checks.staleCloudEnv, false);
    assert.equal(noConfig.checks.configuredCloudUrl, null);
  } finally {
    if (savedConfig === null) { try { await rm(CONFIG_PATH); } catch {} } else { await writeFile(CONFIG_PATH, savedConfig); }
    if (savedUrl === undefined) delete process.env.TERRARIUM_URL; else process.env.TERRARIUM_URL = savedUrl;
  }
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
    // The owning subscriber is attributed so the requeue step is runnable.
    assert.ok(result.details.staleInflightCallbackSubscriberIds.includes(subscriberId));
    const stale = result.repairPlan.find((step) => step.kind === 'staleInflightCallback' && step.subscriberId === subscriberId);
    assert.ok(stale, 'expected a staleInflightCallback repair step for the affected subscriber');
    assert.equal(stale.action, 'requeue');
    assert.equal(stale.tool, 'terrarium_callbacks');
    assert.equal(stale.args.action, 'requeue');
    // requeue requires subscriberId; the step must carry it so an agent can run
    // the plan literally without hitting "callback requeue requires subscriberId".
    assert.equal(stale.args.subscriberId, subscriberId);
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
    assert.ok(result.checks.staleInflightCallbacks >= baseline.checks.staleInflightCallbacks + 1);
    assert.ok(result.checks.malformedAcknowledgedCallbacks >= baseline.checks.malformedAcknowledgedCallbacks + 1);
    assert.ok(result.checks.routerRepairCandidates >= baseline.checks.routerRepairCandidates);
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
    assert.ok(result.checks.malformedSubscribers >= baseline.checks.malformedSubscribers + 1);
    assert.ok(result.checks.malformedInflightCallbacks >= baseline.checks.malformedInflightCallbacks + 1);
    assert.ok(result.checks.inflightCallbacks >= baseline.checks.inflightCallbacks + 1);
    assert.ok(result.checks.staleInflightCallbacks >= baseline.checks.staleInflightCallbacks);
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
