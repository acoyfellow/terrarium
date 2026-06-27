import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBatch, BATCH_STRATEGIES } from '../src/batch.js';
import { getRunGroupStatus } from '../src/groups.js';
import { BATCH_API_VERSION, MCP_SCHEMA_VERSION } from '../src/versions.js';
import { clearInheritedTerrariumEnv } from './helpers/terrarium-env.js';

clearInheritedTerrariumEnv();

let dir;
function agent(name, body) {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, body);
  return `${process.execPath} ${script}`;
}
function job(agentCmd, task = 'batch job') {
  return { task, agent: agentCmd, requireTaskContract: false, stream: false };
}

const ok = () => agent('ok-' + Math.random().toString(36).slice(2), `console.log('done ok');process.exit(0);`);
const fail = () => agent('fail-' + Math.random().toString(36).slice(2), `console.error('boom');process.exit(1);`);
const slow = (ms) => agent('slow-' + Math.random().toString(36).slice(2), `setTimeout(()=>{console.log('slow done');process.exit(0)},${ms});`);

test.before(() => { dir = mkdtempSync(join(tmpdir(), 'terra-batch-')); });
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('version truth: batch response schemaVersion is the MCP wire version, not the batch contract version', () => {
  assert.notEqual(MCP_SCHEMA_VERSION, BATCH_API_VERSION);
  assert.ok(MCP_SCHEMA_VERSION.startsWith('terrarium-mcp-'));
  assert.ok(BATCH_API_VERSION.startsWith('terrarium-batch-'));
});

test('validates inputs', async () => {
  await assert.rejects(() => spawnBatch({ jobs: [] }), /1-32 jobs/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], strategy: 'bogus' }), /invalid batch strategy/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], strategy: 'quorum' }), /quorum strategy requires/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], concurrency: 0 }), /concurrency/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], cleanupTimeoutMs: -1 }), /cleanupTimeoutMs/);
  assert.deepEqual(BATCH_STRATEGIES, ['all', 'allSettled', 'race', 'any', 'quorum']);
});

test('all: resolves ok only when every job succeeds', { timeout: 45000 }, async () => {
  const good = await spawnBatch({ jobs: [job(ok()), job(ok())], strategy: 'all', pollMs: 100 });
  assert.equal(good.ok, true);
  assert.equal(good.apiVersion, BATCH_API_VERSION);
  assert.equal(good.schemaVersion, MCP_SCHEMA_VERSION);
  assert.ok(good.supportedOptions.includes('cleanupTimeoutMs'));
  assert.equal(good.group.counts.done, 2);

  const mixed = await spawnBatch({ jobs: [job(ok()), job(fail())], strategy: 'all', pollMs: 100 });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.group.counts.done, 1);
  assert.equal(mixed.group.counts.failed, 1);
});

test('allSettled: completes every job without disguising child failures', { timeout: 45000 }, async () => {
  const r = await spawnBatch({ jobs: [job(ok()), job(fail())], strategy: 'allSettled', pollMs: 100 });
  assert.equal(r.settled, true);
  assert.equal(r.ok, false);
  assert.equal(r.group.complete, true);
  assert.equal(r.group.ok, false);
  assert.equal(r.successCount, 1);
  assert.equal(r.failureCount, 1);
});

test('allSettled timeout bounds synchronous cancellation settlement for client timeout safety', { timeout: 45000 }, async () => {
  const started = Date.now();
  const r = await spawnBatch({
    jobs: [job(slow(35000))],
    strategy: 'allSettled',
    pollMs: 10,
    timeoutMs: 1500,
    cleanupTimeoutMs: 100,
  });

  assert.ok(Date.now() - started < 3000, 'batch must return before a typical client timeout while cancellation settles durably');

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.timedOut, true);
  assert.match(r.groupId, /^grp_/);
  assert.equal(r.runIds.length, 1);
  assert.equal(r.group.groupId, r.groupId);
  assert.equal(r.group.runs[0].runId, r.runIds[0]);
  assert.ok(Array.isArray(r.cleanupErrors));
  if (r.cleanupErrors.length) {
    assert.match(r.cleanupErrors[0], new RegExp(`^${r.runIds[0]}: run did not become terminal within`));
  }
  // stillSettling must give the exact run IDs that did not settle in time, as
  // structured data, so dogfooders can poll/recover them without parsing
  // free-text cleanupErrors. It is the machine-readable mirror of cleanupErrors.
  assert.ok(Array.isArray(r.stillSettling));
  assert.equal(r.stillSettling.length, r.cleanupErrors.length);
  for (const id of r.stillSettling) {
    assert.ok(r.runIds.includes(id), 'stillSettling ids must belong to this batch');
  }
});

test('batch timeout also bounds active-concurrency launch stage', { timeout: 45000 }, async () => {
  const started = Date.now();
  const r = await spawnBatch({
    jobs: [job(slow(35000)), job(ok())],
    strategy: 'allSettled',
    concurrency: 1,
    pollMs: 10,
    timeoutMs: 500,
    cleanupTimeoutMs: 0,
  });
  assert.ok(Date.now() - started < 2000, 'batch timeout must apply before every concurrency-limited job launches');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.timedOut, true);
  assert.equal(r.phase, 'launch');
  assert.equal(r.runIds.length, 1);
  assert.equal(r.launchedCount, 1);
  assert.equal(r.unlaunchedCount, 1);
  assert.match(r.groupId, /^grp_/);
  assert.ok(Array.isArray(r.cleanupErrors));
  // Every batch return path must carry stillSettling so dogfooders read it
  // unconditionally; this is the launch-timeout branch of that invariant.
  assert.ok(Array.isArray(r.stillSettling), 'launch-timeout result must include stillSettling array');
});

test('race: small cleanup timeout returns a durable result instead of throwing during loser cleanup', { timeout: 45000 }, async () => {
  const started = Date.now();
  const r = await spawnBatch({
    jobs: [job(ok()), job(slow(8000))],
    strategy: 'race',
    pollMs: 10,
    cleanupTimeoutMs: 0,
  });

  assert.ok(Date.now() - started < 12000, 'race must not block past the bounded slow loser duration');
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'race-winner');
  assert.match(r.groupId, /^grp_/);
  assert.equal(r.runIds.length, 2);
  assert.ok(Array.isArray(r.cleanupErrors));
  assert.ok(r.cleanupErrors.length <= 1);
  if (r.cleanupErrors.length) assert.match(r.cleanupErrors[0], /run did not become terminal within/);
});

test('any: first success wins and losers are cancelled', { timeout: 45000 }, async () => {
  const r = await spawnBatch({ jobs: [job(slow(8000)), job(ok()), job(slow(8000))], strategy: 'any', pollMs: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'any-success');
  const status = await getRunGroupStatus({ groupId: r.groupId });
  assert.equal(status.counts.running, 0, 'no runs should remain running after any');
  assert.ok(status.counts.cancelled >= 1, 'slow losers should be cancelled');
  assert.equal(status.complete, true, 'cancelled runs are terminal');
  assert.equal(status.ok, false, 'a group with cancelled children is not wholly successful');
  assert.ok(Array.isArray(r.cleanupErrors));
});

test('any: fails when all jobs fail', { timeout: 45000 }, async () => {
  const r = await spawnBatch({ jobs: [job(fail()), job(fail())], strategy: 'any', pollMs: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'any-exhausted');
});

test('quorum: resolves when k successes reached, cancels the rest', { timeout: 45000 }, async () => {
  const r = await spawnBatch({ jobs: [job(ok()), job(ok()), job(slow(8000))], strategy: 'quorum', quorum: 2, pollMs: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'quorum-reached');
  assert.equal(r.winners.length, 2);
  const status = await getRunGroupStatus({ groupId: r.groupId });
  assert.equal(status.counts.running, 0);
  assert.ok(Array.isArray(r.cleanupErrors));
});

test('quorum: small cleanup timeout returns a durable result instead of throwing during loser cleanup', { timeout: 45000 }, async () => {
  const started = Date.now();
  const r = await spawnBatch({
    jobs: [job(ok()), job(slow(35000))],
    strategy: 'quorum',
    quorum: 1,
    pollMs: 10,
    cleanupTimeoutMs: 0,
  });

  assert.ok(Date.now() - started < 2000, 'quorum must not block on loser settlement');
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'quorum-reached');
  assert.match(r.groupId, /^grp_/);
  assert.equal(r.runIds.length, 2);
  assert.ok(Array.isArray(r.cleanupErrors));
  assert.ok(r.cleanupErrors.length <= 1);
  if (r.cleanupErrors.length) assert.match(r.cleanupErrors[0], /run did not become terminal within/);
});

test('concurrency holds a slot until the active run is terminal', { timeout: 45000 }, async () => {
  const started = Date.now();
  const r = await spawnBatch({ jobs: [job(slow(250)), job(slow(250)), job(slow(250))], strategy: 'all', concurrency: 1, pollMs: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.runIds.length, 3);
  assert.ok(Date.now() - started >= 700, 'concurrency=1 must serialize active child lifetimes, not just launcher calls');
});
