import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { _testables } from '../src/cloud/run-control-do.js';
import { handleApiRuns } from '../src/cloud/api-runs.js';

const { SqlRunStateStore, SqlLogArtifactStore, MAX_LOG_SQL_BYTES } = _testables;

function sqlShim(db = new DatabaseSync(':memory:')) {
  return {
    db,
    exec(sql, ...bindings) {
      const query = /^\s*(SELECT|PRAGMA)/i.test(sql);
      if (!bindings.length && !query) {
        db.exec(sql);
        return { toArray: () => [] };
      }
      const statement = db.prepare(sql);
      if (query) return { toArray: () => statement.all(...bindings) };
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

function makeStore(bucket) {
  const sql = sqlShim();
  new SqlRunStateStore(sql);
  return { sql, store: new SqlLogArtifactStore(sql, { TERRARIUM_ARTIFACTS: bucket }) };
}

function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) { objects.set(key, new Uint8Array(value)); },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { async arrayBuffer() { return bytes.slice().buffer; } } : null;
    },
  };
}

async function overflow(store, runId = 'ter_r2') {
  store.append(runId, `inline-${'💩'.repeat(Math.ceil(MAX_LOG_SQL_BYTES / 4))}-tail`);
  await store.flush(runId);
  return store.logRefs(runId);
}

test('R2 refs verify exact UTF-8 bytes and survive store reconstruction', async () => {
  const bucket = memoryBucket();
  const { sql, store } = makeStore(bucket);
  const refs = await overflow(store);
  assert.equal(refs.length, 1);
  assert.match(refs[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(refs[0].byteCount, [...bucket.objects.values()][0].byteLength);

  const reconstructed = new SqlLogArtifactStore(sql, { TERRARIUM_ARTIFACTS: bucket });
  const read = await reconstructed.readRef('ter_r2', refs[0].seq);
  assert.equal(read.byteCount, refs[0].byteCount);
  assert.equal(read.sha256, refs[0].sha256);
  assert.deepEqual(read.bytes, [...bucket.objects.values()][0]);
});

test('settled R2 rejection remains latched across a microtask before flush', async () => {
  const { store } = makeStore({ async put() { throw new Error('R2 unavailable'); } });
  store.append('ter_failure', 'x'.repeat(MAX_LOG_SQL_BYTES + 1));
  await Promise.resolve();
  await Promise.resolve();
  await assert.rejects(() => store.flush('ter_failure'), /R2 unavailable/);
  assert.deepEqual(store.logRefs('ter_failure'), []);
});

test('retrieval supports a streaming R2 body and detects count/digest corruption', async () => {
  const bucket = memoryBucket();
  const { sql, store } = makeStore(bucket);
  const [ref] = await overflow(store, 'ter_stream');
  const bytes = [...bucket.objects.values()][0];
  bucket.get = async () => ({ body: new Response(bytes).body });
  assert.deepEqual((await store.readRef('ter_stream', ref.seq)).bytes, bytes);

  sql.exec('UPDATE log_offload SET byte_count = byte_count + 1 WHERE run_id = ?', 'ter_stream');
  await assert.rejects(() => store.readRef('ter_stream', ref.seq), (error) => error.code === 'R2_CORRUPT');
  sql.exec('UPDATE log_offload SET byte_count = ?, sha256 = ? WHERE run_id = ?', bytes.byteLength, '0'.repeat(64), 'ter_stream');
  await assert.rejects(() => store.readRef('ter_stream', ref.seq), (error) => error.code === 'R2_CORRUPT');
});

test('missing object and legacy digest fail closed with stable non-leaking codes', async () => {
  const bucket = memoryBucket();
  const { sql, store } = makeStore(bucket);
  const [ref] = await overflow(store, 'ter_missing');
  bucket.objects.clear();
  await assert.rejects(() => store.readRef('ter_missing', ref.seq), (error) => error.code === 'R2_OBJECT_MISSING' && !error.message.includes('runs/'));
  sql.exec('UPDATE log_offload SET sha256 = NULL WHERE run_id = ?', 'ter_missing');
  await assert.rejects(() => store.readRef('ter_missing', ref.seq), (error) => error.code === 'R2_UNVERIFIED_LEGACY');
  await assert.rejects(() => store.readRef('ter_missing', ref.seq + 99), (error) => error.code === 'R2_NOT_FOUND');
});

test('public API rejects non-canonical seq before dispatching to the run DO', async () => {
  let fetches = 0;
  const env = {
    TERRARIUM_PRINCIPAL_ID: 'principal-r2',
    TERRARIUM_CONTROL_TOKEN_CURRENT: 'token-r2',
    TERRARIUM_RUN: {
      idFromName(name) { return { name }; },
      get() { return { async fetch() { fetches += 1; return new Response('unexpected'); } }; },
    },
  };
  for (const seq of ['1x', '1.0', '+1', '01', '-1', '']) {
    const response = await handleApiRuns(new Request(`https://worker/api/runs/ter_valid/logs/ref?seq=${encodeURIComponent(seq)}`, {
      headers: { authorization: 'Bearer token-r2' },
    }), env);
    assert.equal(response.status, 400, seq);
  }
  assert.equal(fetches, 0);
});
