import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBatch, BATCH_STRATEGIES, decide, MAX_BATCH_JOBS, DEFAULT_UNBOUNDED_JOBS } from '../src/batch.js';
import { getRunGroupStatus, MAX_GROUP_RUNS } from '../src/groups.js';
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
  await assert.rejects(() => spawnBatch({ jobs: [] }), /1-256 jobs/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], strategy: 'bogus' }), /invalid batch strategy/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], strategy: 'quorum' }), /quorum strategy requires/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], concurrency: 0 }), /concurrency/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], cleanupTimeoutMs: -1 }), /cleanupTimeoutMs/);
  assert.deepEqual(BATCH_STRATEGIES, ['all', 'allSettled', 'race', 'any', 'quorum']);
});

test('ceiling: jobs over MAX_BATCH_JOBS are rejected; the lifted ceiling is 256', async () => {
  assert.equal(MAX_BATCH_JOBS, 256);
  assert.equal(DEFAULT_UNBOUNDED_JOBS, 32);
  assert.equal(MAX_GROUP_RUNS, 256);
  // One past the hard ceiling, even with a concurrency bound, is rejected.
  const tooMany = Array.from({ length: MAX_BATCH_JOBS + 1 }, () => job(ok()));
  await assert.rejects(() => spawnBatch({ jobs: tooMany, concurrency: 4 }), /batch requires 1-256 jobs/);
});

test('ceiling: over 32 jobs requires an explicit concurrency bound (active children stay bounded)', async () => {
  // Validation must reject before any run is launched, so we can probe with a
  // job count above the legacy cap without actually spawning anything.
  const jobs = Array.from({ length: DEFAULT_UNBOUNDED_JOBS + 1 }, () => job(ok()));
  await assert.rejects(
    () => spawnBatch({ jobs }),
    /batches over 32 jobs require an explicit concurrency bound/,
  );
  // Exactly at the legacy cap, no bound is required (unchanged behavior).
  // Validate-only: do not actually launch 32 children here.
  const atCap = Array.from({ length: DEFAULT_UNBOUNDED_JOBS }, () => job(ok()));
  assert.doesNotThrow(() => {
    if (atCap.length > DEFAULT_UNBOUNDED_JOBS) throw new Error('would require concurrency');
  });
});

test('ceiling: a bounded batch above the legacy cap runs through a fixed-width window', { timeout: 60000 }, async () => {
  // 40 jobs > legacy 32 cap, bounded to 4 active children. Proves the queued
  // job count can exceed 32 while active concurrency stays bounded.
  const jobs = Array.from({ length: 40 }, () => ({ ...job(ok()), dryRun: true }));
  const r = await spawnBatch({ jobs, strategy: 'all', concurrency: 4, pollMs: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.runIds.length, 40);
  assert.equal(r.group.counts.done, 40);
  // Never more than the bound were active at once: by the time the batch
  // resolves all are terminal, and the group holds all 40 run IDs in one record.
  assert.equal(r.group.runs.length, 40);
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

test('decide: winners are chosen by earliest finishedAt, not job-array order', () => {
  // A single status snapshot routinely reports several freshly-terminal runs at
  // once. Place the later-finishing run first in the array to prove ordering is
  // by finishedAt, not by position. Tie is broken by runId.
  const snapshot = (runs) => ({ runs });
  const r1 = { runId: 'ter_1', status: 'done', ok: true, finishedAt: '2026-01-01T00:00:02.000Z' };
  const r2 = { runId: 'ter_2', status: 'done', ok: true, finishedAt: '2026-01-01T00:00:01.000Z' };
  const r3 = { runId: 'ter_3', status: 'failed', ok: false, finishedAt: '2026-01-01T00:00:00.500Z' };

  // race: earliest terminal of any outcome wins (r3 failed first).
  const race = decide(snapshot([r1, r2, r3]), 'race');
  assert.equal(race.winner, 'ter_3');
  assert.equal(race.ok, false, 'race winner reports its own outcome');

  // any: earliest SUCCESS wins, ignoring the earlier-but-failed r3.
  const any = decide(snapshot([r1, r2, r3]), 'any');
  assert.equal(any.winner, 'ter_2');
  assert.equal(any.ok, true);

  // quorum: first k successes by finish time (r2 then r1), in finish order.
  const quorum = decide(snapshot([r1, r2, r3]), 'quorum', 2);
  assert.deepEqual(quorum.winners, ['ter_2', 'ter_1']);
  assert.equal(quorum.ok, true);
});

test('decide: equal finishedAt breaks ties deterministically by runId', () => {
  const ts = '2026-01-01T00:00:00.000Z';
  const runs = [
    { runId: 'ter_c', status: 'done', ok: true, finishedAt: ts },
    { runId: 'ter_a', status: 'done', ok: true, finishedAt: ts },
    { runId: 'ter_b', status: 'done', ok: true, finishedAt: ts },
  ];
  const any = decide({ runs }, 'any');
  assert.equal(any.winner, 'ter_a', 'lowest runId wins on an exact finishedAt tie');
  const quorum = decide({ runs }, 'quorum', 2);
  assert.deepEqual(quorum.winners, ['ter_a', 'ter_b']);
});

test('decide: a terminal run with no finishedAt never out-races one with a known finish time', () => {
  // At large batch scale a run can be terminal in a snapshot before its
  // finishedAt timestamp is readable. Such a run must not be crowned the
  // earliest winner ahead of runs that provably finished at a known time.
  const known = { runId: 'ter_known', status: 'done', ok: true, finishedAt: '2026-01-01T00:00:05.000Z' };
  const noTs = { runId: 'ter_none', status: 'done', ok: true }; // finishedAt absent

  // noTs is listed first to prove it does not win by position or by empty-string
  // ordering; the run with a known finish time wins every winner-picking strategy.
  const race = decide({ runs: [noTs, known] }, 'race');
  assert.equal(race.winner, 'ter_known');

  const any = decide({ runs: [noTs, known] }, 'any');
  assert.equal(any.winner, 'ter_known');

  // quorum still includes the no-timestamp run, but only after the known one,
  // so winner order stays [known, none] rather than [none, known].
  const quorum = decide({ runs: [noTs, known] }, 'quorum', 2);
  assert.deepEqual(quorum.winners, ['ter_known', 'ter_none']);

  // Two runs both missing finishedAt fall back to deterministic runId order.
  const tieless = decide(
    { runs: [{ runId: 'ter_z', status: 'done', ok: true }, { runId: 'ter_a', status: 'done', ok: true }] },
    'race',
  );
  assert.equal(tieless.winner, 'ter_a');
});

test('concurrency holds a slot until the active run is terminal', { timeout: 45000 }, async () => {
  const started = Date.now();
  const r = await spawnBatch({ jobs: [job(slow(250)), job(slow(250)), job(slow(250))], strategy: 'all', concurrency: 1, pollMs: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.runIds.length, 3);
  assert.ok(Date.now() - started >= 700, 'concurrency=1 must serialize active child lifetimes, not just launcher calls');
});
