import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApiBatches } from '../src/cloud/api-batches.js';
import { indexRunTerminal, listPrincipalRuns } from '../src/cloud/run-index.js';

// ---------------------------------------------------------------------------
// Test doubles. These implement the exact Workers surfaces api-batches ->
// admitOneRun touches: KV (TERRARIUM_LEDGER), the PrincipalBudget DO
// (TERRARIUM_PRINCIPAL_BUDGET), and the RunControl DO (TERRARIUM_RUN). The
// batch path is exercised through the REAL admitOneRun helper — no fork, no
// mock of the admit logic itself.
// ---------------------------------------------------------------------------

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

// Budget DO: /reserve echoes back the runId it was given (canonical identity).
function makeBudgetNS() {
  return {
    idFromName: (n) => ({ name: n }),
    get: () => ({
      async fetch(_url, init) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, runId: body.runId }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
    }),
  };
}

// RunControl DO namespace whose /admit path counts concurrent in-flight admits
// so the test can prove the maxConcurrency window (proof gate 2). `admitDelay`
// forces overlap; `failIndexes` lets a chosen admit return non-202.
function makeRunNS({ admitDelayMs = 15, onAdmit } = {}) {
  const state = { live: 0, peak: 0, admitted: [] };
  const ns = {
    _state: state,
    idFromName: (n) => ({ name: n }),
    get: (id) => ({
      async fetch(url, init) {
        const path = new URL(url).pathname;
        if (path === '/admit') {
          const body = JSON.parse(init.body);
          state.live++;
          if (state.live > state.peak) state.peak = state.live;
          await new Promise((r) => setTimeout(r, admitDelayMs));
          state.live--;
          const outcome = onAdmit ? onAdmit(body) : { status: 202 };
          if (outcome.status === 202) {
            state.admitted.push(body.runId);
            return new Response(JSON.stringify({ admitted: true, runId: body.runId, contract: {} }), {
              status: 202, headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ admitted: false, reason: outcome.reason || 'rejected' }), {
            status: outcome.status, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      },
    }),
  };
  return ns;
}

function makeEnv(overrides = {}) {
  return {
    TERRARIUM_PRINCIPAL_ID: 'owner-1',
    TERRARIUM_CONTROL_TOKEN_CURRENT: 'tok-current-abcdefgh',
    TERRARIUM_LEDGER: makeKV(),
    TERRARIUM_PRINCIPAL_BUDGET: makeBudgetNS(),
    TERRARIUM_RUN: makeRunNS(),
    ...overrides,
  };
}

function post(body, { token = 'tok-current-abcdefgh', idem = 'batch-key-0001' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers['idempotency-key'] = idem;
  return new Request('https://terrarium.coey.dev/api/batches', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
}

function getBatch(batchId, { token = 'tok-current-abcdefgh' } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`https://terrarium.coey.dev/api/batches/${batchId}`, { method: 'GET', headers });
}

const tasks = (n) => Array.from({ length: n }, (_, i) => `task number ${i}`);

// --- auth gate (mirrors /api/runs) ----------------------------------------

test('POST /api/batches requires auth (401 without token)', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(post({ tasks: tasks(3) }, { token: null }), env);
  assert.equal(res.status, 401);
});

test('POST /api/batches requires an idempotency-key', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(post({ tasks: tasks(3) }, { idem: null }), env);
  assert.equal(res.status, 400);
});

// --- GATE 2: peak live admissions <= maxConcurrency -----------------------

test('GATE 2: peak concurrent admits never exceeds maxConcurrency', async () => {
  const runNS = makeRunNS({ admitDelayMs: 20 });
  const env = makeEnv({ TERRARIUM_RUN: runNS });
  const res = await handleApiBatches(post({ tasks: tasks(10), maxConcurrency: 3 }), env);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.admitted, 10, 'all 10 admitted');
  assert.ok(body.peakLive <= 3, `client-reported peakLive ${body.peakLive} <= 3`);
  assert.ok(runNS._state.peak <= 3, `DO-observed peak ${runNS._state.peak} <= 3`);
  assert.ok(runNS._state.peak >= 2, 'window actually overlapped admits (not serialized)');
});

test('GATE 2b: maxConcurrency is capped at the per-owner ceiling (8)', async () => {
  const runNS = makeRunNS({ admitDelayMs: 10 });
  const env = makeEnv({ TERRARIUM_RUN: runNS });
  const res = await handleApiBatches(post({ tasks: tasks(12), maxConcurrency: 999 }), env);
  const body = await res.json();
  assert.equal(body.maxConcurrency, 8, 'requested 999 clamped to policy ceiling 8');
  assert.ok(runNS._state.peak <= 8, `DO-observed peak ${runNS._state.peak} <= 8`);
});

// --- GATE: batch record references child runIds only (no inlined receipts) --

test('GATE: batch record references child runIds only', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(post({ tasks: tasks(4), maxConcurrency: 2 }), env);
  const body = await res.json();
  const key = `batchidx:owner-1:${body.batchId}`;
  const rec = JSON.parse(env.TERRARIUM_LEDGER.store.get(key));
  assert.deepEqual(Object.keys(rec).sort(), ['batchId', 'childRunIds', 'createdAt', 'maxConcurrency', 'ownerId'].sort());
  assert.equal(rec.childRunIds.length, 4);
  for (const rid of rec.childRunIds) assert.match(rid, /^ter_/);
  // No receipt-ish fields inlined on the batch record.
  const serialized = JSON.stringify(rec);
  assert.ok(!/receipt|contract|executionRef|nonce/i.test(serialized), 'no receipt fields inlined');
});

// --- GATE: no lost wake/receipt — every admitted child is discoverable ----

test('GATE: every admitted child run is discoverable + counted', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(post({ tasks: tasks(5), maxConcurrency: 4 }), env);
  const body = await res.json();
  assert.equal(body.childRunIds.length, 5);
  // Simulate each child's own run-index projection (admit + terminal) as its DO
  // would write it, then confirm the aggregate reflects all of them.
  for (const rid of body.childRunIds) {
    await import('../src/cloud/run-index.js').then((m) =>
      m.indexRunAdmitted(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: rid, channel: 'batch' }));
  }
  const listed = await listPrincipalRuns(env.TERRARIUM_LEDGER, 'owner-1', { channel: 'batch' });
  assert.equal(listed.runs.length, 5, 'no lost child: all 5 discoverable in the index');
});

// --- GATE 4: failure-truth — non-success NEVER rolled up as done ----------

test('GATE 4: aggregate is "running" while any child is not terminal', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(post({ tasks: tasks(3), maxConcurrency: 3 }), env);
  const { batchId, childRunIds } = await res.json();
  // Project each child as admitted (running); none terminal yet.
  const { indexRunAdmitted } = await import('../src/cloud/run-index.js');
  for (const rid of childRunIds) await indexRunAdmitted(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: rid, channel: 'b' });
  const agg = await handleApiBatches(getBatch(batchId), env).then((r) => r.json());
  assert.equal(agg.status, 'running');
  assert.equal(agg.running, 3);
  assert.equal(agg.done, 0);
});

test('GATE 4: one failed child forces batch status "failed" (never done)', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(post({ tasks: tasks(3), maxConcurrency: 3 }), env);
  const { batchId, childRunIds } = await res.json();
  const { indexRunAdmitted } = await import('../src/cloud/run-index.js');
  for (const rid of childRunIds) await indexRunAdmitted(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: rid, channel: 'b' });
  // Two succeed, one fails.
  await indexRunTerminal(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: childRunIds[0], status: 'done', ok: true });
  await indexRunTerminal(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: childRunIds[1], status: 'done', ok: true });
  await indexRunTerminal(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: childRunIds[2], status: 'failed', ok: false });
  const agg = await handleApiBatches(getBatch(batchId), env).then((r) => r.json());
  assert.equal(agg.status, 'failed', 'a single failure forces failed, never done');
  assert.equal(agg.done, 2);
  assert.equal(agg.failed, 1);
});

test('GATE 4: a "done" child with ok:false is counted as failure, not done', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(post({ tasks: tasks(2), maxConcurrency: 2 }), env);
  const { batchId, childRunIds } = await res.json();
  const { indexRunAdmitted } = await import('../src/cloud/run-index.js');
  for (const rid of childRunIds) await indexRunAdmitted(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: rid, channel: 'b' });
  await indexRunTerminal(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: childRunIds[0], status: 'done', ok: true });
  await indexRunTerminal(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: childRunIds[1], status: 'done', ok: false });
  const agg = await handleApiBatches(getBatch(batchId), env).then((r) => r.json());
  assert.equal(agg.status, 'failed');
  assert.equal(agg.failed, 1);
});

test('GATE 4: batch is "done" only when ALL children terminal AND ok', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(post({ tasks: tasks(3), maxConcurrency: 3 }), env);
  const { batchId, childRunIds } = await res.json();
  const { indexRunAdmitted } = await import('../src/cloud/run-index.js');
  for (const rid of childRunIds) await indexRunAdmitted(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: rid, channel: 'b' });
  for (const rid of childRunIds) await indexRunTerminal(env.TERRARIUM_LEDGER, { ownerId: 'owner-1', runId: rid, status: 'done', ok: true });
  const agg = await handleApiBatches(getBatch(batchId), env).then((r) => r.json());
  assert.equal(agg.status, 'done');
  assert.equal(agg.done, 3);
  assert.equal(agg.failed, 0);
});

// --- GATE 1: same admit path — a rejected admit surfaces, batch not "done" -

test('GATE 1: admit rejection surfaces in rejected[] (reuses admitOneRun)', async () => {
  // Reject the 3rd admit at the RunControl DO; the batch must report it.
  let count = 0;
  const runNS = makeRunNS({ admitDelayMs: 5, onAdmit: () => (++count === 3 ? { status: 409, reason: 'busy' } : { status: 202 }) });
  const env = makeEnv({ TERRARIUM_RUN: runNS });
  const res = await handleApiBatches(post({ tasks: tasks(5), maxConcurrency: 1 }), env);
  const body = await res.json();
  assert.equal(body.admitted, 4);
  assert.equal(body.rejected.length, 1);
  assert.equal(body.rejected[0].status, 409);
  assert.equal(body.childRunIds.length, 4, 'batch record only references successfully admitted children');
});

// --- cross-owner / unknown batch id normalizes to 404 ---------------------

test('GET unknown batchId returns 404 (no enumeration oracle)', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(getBatch('bat_does_not_exist'), env);
  assert.equal(res.status, 404);
});

test('GET malformed batchId returns 400', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(getBatch('not-a-batch-id'), env);
  assert.equal(res.status, 400);
});

test('POST with empty tasks[] returns 400', async () => {
  const env = makeEnv();
  const res = await handleApiBatches(post({ tasks: [] }), env);
  assert.equal(res.status, 400);
});
