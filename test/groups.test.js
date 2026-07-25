import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelRun, getRunStatus, isPidAlive, metadataPath, readRun, runTerrarium, spawnTerrariumBackground } from '../src/core.js';
import { createRunGroup, getRunGroupStatus, listRunGroups, readRunGroupLogs, reconstructContractTruth } from '../src/groups.js';
import { clearInheritedTerrariumEnv } from './helpers/terrarium-env.js';

clearInheritedTerrariumEnv();

test('run groups preserve ordered independent runs and summarize status/logs', async () => {
  const a = await runTerrarium({ task: 'group alpha', dryRun: true, stream: false });
  const b = await runTerrarium({ task: 'group beta', dryRun: true, stream: false });
  const group = await createRunGroup({ label: 'research batch', runIds: [a.runId, b.runId] });
  assert.deepEqual(group.runIds, [a.runId, b.runId]);
  const status = await getRunGroupStatus({ groupId: group.groupId });
  assert.equal(status.complete, true);
  assert.equal(status.ok, true);
  assert.equal(status.counts.done, 2);
  assert.deepEqual(status.runs.map((run) => run.terminalCallback?.eventId), [`evt_${a.runId}_Completed`, `evt_${b.runId}_Completed`]);
  const listing = await listRunGroups({ limit: 100 });
  assert.ok(listing.groups.some((item) => item.groupId === group.groupId));
  const logs = await readRunGroupLogs({ groupId: group.groupId, tailBytes: 200 });
  assert.equal(logs.results.length, 2);
  assert.ok(logs.results.every((result) => typeof result.text === 'string'));
});

test('group truthfulness rejects traversal IDs and does not call missing records complete', async () => {
  for (const groupId of ['../grp_escape', 'grp_ok/../../escape', 'grp_%2e%2e', 'not_a_group']) {
    await assert.rejects(createRunGroup({ groupId, runIds: ['ter_' + 'a'.repeat(20)] }), /invalid Terrarium group id/);
    await assert.rejects(getRunGroupStatus({ groupId }), /invalid Terrarium group id/);
    await assert.rejects(readRunGroupLogs({ groupId }), /invalid Terrarium group id/);
  }

  const groupId = `grp_missing_${Date.now()}`;
  await mkdir(join(process.env.TERRARIUM_HOME || join(process.env.HOME, '.terrarium'), 'groups'), { recursive: true });
  const path = join(process.env.TERRARIUM_HOME || join(process.env.HOME, '.terrarium'), 'groups', `${groupId}.json`);
  await writeFile(path, JSON.stringify({ version: 1, groupId, label: 'missing member', runIds: [`ter_${'f'.repeat(20)}`], createdAt: new Date().toISOString() }));
  try {
    const status = await getRunGroupStatus({ groupId });
    assert.equal(status.counts.missing, 1);
    assert.equal(status.complete, false, 'missing state is unknown, not terminal');
    assert.equal(status.ok, false);
  } finally { rmSync(path, { force: true }); }
});

test('reconstructContractTruth maps every task-contract status to a trust bucket', () => {
  assert.equal(reconstructContractTruth({ taskContractStatus: 'verified' }), 'verified');
  assert.equal(reconstructContractTruth({ taskContractStatus: 'not-required' }), 'not-required');
  assert.equal(reconstructContractTruth({ taskContractStatus: 'not-applicable' }), 'not-applicable');
  assert.equal(reconstructContractTruth({ taskContractStatus: 'pending' }), 'pending');
  for (const untrusted of ['missing', 'mismatch', 'malformed']) {
    assert.equal(reconstructContractTruth({ taskContractStatus: untrusted }), 'unverified', `${untrusted} is present-but-untrusted`);
  }
  // No record / unreadable member yields no contract evidence.
  assert.equal(reconstructContractTruth({ status: 'missing' }), 'unknown');
  assert.equal(reconstructContractTruth(undefined), 'unknown');
});

test('group status reconstructs contract-layer truth distinct from process ok', async () => {
  // Seed terminal member records directly. reconcileRun is a no-op for already
  // terminal records, so the taskContractStatus we write flows straight through
  // getRunStatus into the group roll-up.
  const stamp = Date.now();
  const seed = (suffix, status, taskContractStatus, ok) => {
    const runId = `ter_${'c'.repeat(16)}${suffix}`;
    writeFileSync(metadataPath(runId), JSON.stringify({
      version: 1, runId, status, ok, exitCode: ok ? 0 : 1, taskContractStatus,
      startedAt: new Date(stamp).toISOString(), finishedAt: new Date(stamp).toISOString(),
    }));
    return runId;
  };
  const seeded = [
    seed('a0', 'done', 'verified', true),
    seed('b1', 'cancelled', 'not-applicable', false),
    seed('c2', 'inconclusive', 'missing', false),
  ];
  try {
    const group = await createRunGroup({ label: 'truth recon', runIds: seeded });
    const status = await getRunGroupStatus({ groupId: group.groupId });
    // Process-level: not all done, so process ok is false even though one member verified.
    assert.equal(status.complete, true, 'all members terminal');
    assert.equal(status.ok, false, 'a cancelled + inconclusive member fails process ok');
    // Contract-level truth reconstruction.
    assert.equal(status.contractTruth.buckets.verified, 1);
    assert.equal(status.contractTruth.buckets['not-applicable'], 1, 'cancelled run is untrusted, not verified');
    assert.equal(status.contractTruth.buckets.unverified, 1, 'a missing receipt is a present-but-untrusted claim');
    assert.equal(status.contractTruth.trusted, 1, 'only the genuinely verified member contributes trust');
    assert.equal(status.contractTruth.fullyVerified, false, 'one verified member does not verify the whole group');
  } finally {
    for (const runId of seeded) rmSync(metadataPath(runId), { force: true });
  }
});

test('group contractTruth.fullyVerified requires every member verified', async () => {
  // Use an explicit deterministic local child. Falling back to the developer's
  // configured model runner makes this hermetic test depend on network/model
  // availability and can leave an unbounded OpenCode process behind.
  const agent = `${process.execPath} -e "console.log('group-test-ok')"`;
  const a = await runTerrarium({ task: 'verify alpha', agent, dryRun: false, stream: false, requireTaskContract: false });
  const b = await runTerrarium({ task: 'verify beta', agent, dryRun: false, stream: false, requireTaskContract: false });
  const group = await createRunGroup({ label: 'all not-required', runIds: [a.runId, b.runId] });
  const status = await getRunGroupStatus({ groupId: group.groupId });
  // These dry/non-contract runs are not-required: trusted, but not 'verified'.
  assert.equal(status.contractTruth.buckets['not-required'], 2);
  assert.equal(status.contractTruth.trusted, 2, 'not-required members are trusted evidence');
  assert.equal(status.contractTruth.fullyVerified, false, 'fullyVerified is strict: not-required is not verified');
});

test('cancel terminates the child process group and records cancelled status', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terra-cancel-agent-'));
  const script = join(dir, 'agent.mjs');
  writeFileSync(script, `import{spawn}from'node:child_process';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('GRANDCHILD='+c.pid);setInterval(()=>{},1000);`);
  try {
    const run = await spawnTerrariumBackground({ task: 'cancel process tree', agent: `${process.execPath} ${script}`, requireTaskContract: false });
    let grandchild;
    for (let i = 0; i < 200; i++) {
      const log = await readRun({ runId: run.runId });
      const match = log.text.match(/GRANDCHILD=(\d+)/);
      if (match) { grandchild = Number(match[1]); break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(grandchild, 'expected grandchild PID in run log');
    assert.equal(isPidAlive(grandchild), true);
    const request = await cancelRun({ runId: run.runId });
    assert.equal(request.cancelled, true);
    let status;
    for (let i = 0; i < 80; i++) {
      status = await getRunStatus({ runId: run.runId, staleMs: 1000 });
      if (status.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.status, 'cancelled');
    assert.equal(status.ok, false);
    assert.equal(isPidAlive(grandchild), false);
    const group = await createRunGroup({ label: 'cancelled child', runIds: [run.runId] });
    const groupStatus = await getRunGroupStatus({ groupId: group.groupId });
    assert.equal(groupStatus.complete, true, 'cancelled is terminal, not stale running');
    assert.equal(groupStatus.ok, false, 'cancelled is not successful');
    assert.equal(groupStatus.counts.cancelled, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
