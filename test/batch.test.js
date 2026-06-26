import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBatch, BATCH_STRATEGIES } from '../src/batch.js';
import { getRunGroupStatus } from '../src/groups.js';

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

test('validates inputs', async () => {
  await assert.rejects(() => spawnBatch({ jobs: [] }), /1-32 jobs/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], strategy: 'bogus' }), /invalid batch strategy/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], strategy: 'quorum' }), /quorum strategy requires/);
  await assert.rejects(() => spawnBatch({ jobs: [job(ok())], concurrency: 0 }), /concurrency/);
  assert.deepEqual(BATCH_STRATEGIES, ['all', 'allSettled', 'race', 'any', 'quorum']);
});

test('all: resolves ok only when every job succeeds', { timeout: 45000 }, async () => {
  const good = await spawnBatch({ jobs: [job(ok()), job(ok())], strategy: 'all', pollMs: 100 });
  assert.equal(good.ok, true);
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

test('allSettled timeout preserves the durable batch result when cancellation settlement fails', { timeout: 45000 }, async () => {
  const r = await spawnBatch({
    jobs: [job(slow(35000))],
    strategy: 'allSettled',
    pollMs: 10,
    timeoutMs: 1,
  });

  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.timedOut, true);
  assert.match(r.groupId, /^grp_/);
  assert.equal(r.runIds.length, 1);
  assert.equal(r.group.groupId, r.groupId);
  assert.equal(r.group.runs[0].runId, r.runIds[0]);
  assert.ok(Array.isArray(r.cleanupErrors));
  if (r.cleanupErrors.length) {
    assert.match(r.cleanupErrors[0], new RegExp(`^${r.runIds[0]}: run did not become terminal after cancellation`));
  }
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

test('concurrency holds a slot until the active run is terminal', { timeout: 45000 }, async () => {
  const started = Date.now();
  const r = await spawnBatch({ jobs: [job(slow(250)), job(slow(250)), job(slow(250))], strategy: 'all', concurrency: 1, pollMs: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.runIds.length, 3);
  assert.ok(Date.now() - started >= 700, 'concurrency=1 must serialize active child lifetimes, not just launcher calls');
});
