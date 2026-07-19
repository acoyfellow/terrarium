import test from 'node:test';
import assert from 'node:assert/strict';
import { indexRunAdmitted, indexRunTerminal, listPrincipalRuns } from '../src/cloud/run-index.js';

// Minimal KV mock matching the Workers KV surface used by run-index:
//   put(key, string), get(key, {type:"json"}) -> parsed|null, list({prefix,cursor,limit})
function makeKV() {
  const store = new Map();
  return {
    store,
    async put(key, val) { store.set(key, val); },
    async get(key, opts) {
      const raw = store.get(key);
      if (raw == null) return null;
      return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + limit);
      const nextStart = start + limit;
      const complete = nextStart >= all.length;
      return { keys: slice.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : String(nextStart) };
    },
  };
}

test('run-index: admit then terminal produces one discoverable record', async () => {
  const kv = makeKV();
  const t0 = Date.now();
  assert.equal(await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'ter_a', channel: 'loop-x', taskFingerprint: 'fp1', grounding: 'cloud', createdAt: t0 }), true);
  let { runs } = await listPrincipalRuns(kv, 'p1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'running');
  assert.equal(runs[0].channel, 'loop-x');
  assert.equal(runs[0].grounding, 'cloud');

  assert.equal(await indexRunTerminal(kv, { ownerId: 'p1', runId: 'ter_a', status: 'done', ok: true, terminalAt: t0 + 500 }), true);
  ({ runs } = await listPrincipalRuns(kv, 'p1'));
  assert.equal(runs.length, 1, 'terminal update targets the same key, not a new record');
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[0].ok, true);
  assert.equal(runs[0].channel, 'loop-x', 'channel preserved from admit record');
  assert.equal(runs[0].createdAt, t0, 'createdAt preserved from admit record');
  assert.equal(runs[0].terminalAt, t0 + 500);
});

test('run-index: workflowId is opt-in (trap default == runId is dropped)', async () => {
  const kv = makeKV();
  await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'ter_b', workflowId: 'ter_b', channel: 'c' });
  await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'ter_c', workflowId: 'batch-42', channel: 'c' });
  const { runs } = await listPrincipalRuns(kv, 'p1');
  const b = runs.find((r) => r.runId === 'ter_b');
  const c = runs.find((r) => r.runId === 'ter_c');
  assert.equal(b.workflowId, null, 'workflowId == runId is a trap default and dropped');
  assert.equal(c.workflowId, 'batch-42', 'explicit workflowId is kept');
});

test('run-index: per-principal isolation (no cross-owner leakage)', async () => {
  const kv = makeKV();
  await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'ter_1', channel: 'x' });
  await indexRunAdmitted(kv, { ownerId: 'p2', runId: 'ter_2', channel: 'x' });
  const p1 = await listPrincipalRuns(kv, 'p1');
  const p2 = await listPrincipalRuns(kv, 'p2');
  assert.deepEqual(p1.runs.map((r) => r.runId), ['ter_1']);
  assert.deepEqual(p2.runs.map((r) => r.runId), ['ter_2']);
});

test('run-index: filters by channel, status, since; recent-first order', async () => {
  const kv = makeKV();
  const base = 1_000_000;
  await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'r1', channel: 'a', createdAt: base + 1 });
  await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'r2', channel: 'b', createdAt: base + 2 });
  await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'r3', channel: 'a', createdAt: base + 3 });
  await indexRunTerminal(kv, { ownerId: 'p1', runId: 'r3', status: 'done', ok: true, terminalAt: base + 4 });

  const all = await listPrincipalRuns(kv, 'p1');
  assert.deepEqual(all.runs.map((r) => r.runId), ['r3', 'r2', 'r1'], 'most-recent-first by createdAt');

  const chanA = await listPrincipalRuns(kv, 'p1', { channel: 'a' });
  assert.deepEqual(chanA.runs.map((r) => r.runId).sort(), ['r1', 'r3']);

  const running = await listPrincipalRuns(kv, 'p1', { status: 'running' });
  assert.deepEqual(running.runs.map((r) => r.runId).sort(), ['r1', 'r2']);

  const since = await listPrincipalRuns(kv, 'p1', { since: base + 3 });
  assert.deepEqual(since.runs.map((r) => r.runId), ['r3']);
});

test('run-index: channel rollup groups counts by channel', async () => {
  const kv = makeKV();
  await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'r1', channel: 'loop-a' });
  await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'r2', channel: 'loop-a' });
  await indexRunTerminal(kv, { ownerId: 'p1', runId: 'r2', status: 'done', ok: true });
  await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'r3', channel: 'loop-b' });
  await indexRunTerminal(kv, { ownerId: 'p1', runId: 'r3', status: 'failed', ok: false });
  const { channels } = await listPrincipalRuns(kv, 'p1');
  assert.equal(channels['loop-a'].total, 2);
  assert.equal(channels['loop-a'].running, 1);
  assert.equal(channels['loop-a'].done, 1);
  assert.equal(channels['loop-b'].failed, 1);
});

test('run-index: terminal reconstructs a record when admit write was lost (fail-soft)', async () => {
  const kv = makeKV();
  // No admit write — simulate a lost/failed projection at admit.
  assert.equal(await indexRunTerminal(kv, { ownerId: 'p1', runId: 'orphan', status: 'done', ok: true, channel: 'c', grounding: 'cloudbox' }), true);
  const { runs } = await listPrincipalRuns(kv, 'p1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, 'orphan');
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[0].grounding, 'cloudbox');
});

test('run-index: never throws and returns false on unavailable KV or bad input', async () => {
  assert.equal(await indexRunAdmitted(null, { ownerId: 'p1', runId: 'r' }), false);
  assert.equal(await indexRunAdmitted({}, { ownerId: 'p1', runId: 'r' }), false);
  const kv = makeKV();
  assert.equal(await indexRunAdmitted(kv, { ownerId: 'bad owner!', runId: 'r' }), false, 'invalid ownerId rejected');
  assert.equal(await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'bad id!' }), false, 'invalid runId rejected');
  const { runs, channels } = await listPrincipalRuns(null, 'p1');
  assert.deepEqual(runs, []);
  assert.deepEqual(channels, {});
});

test('run-index: put failure is swallowed (projection never fails the caller)', async () => {
  const kv = makeKV();
  kv.put = async () => { throw new Error('KV down'); };
  assert.equal(await indexRunAdmitted(kv, { ownerId: 'p1', runId: 'r' }), false);
  assert.equal(await indexRunTerminal(kv, { ownerId: 'p1', runId: 'r', status: 'done', ok: true }), false);
});
