import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOG_DIR, getRunStatus, readRun, runTerrarium } from '../src/core.js';
import { JOURNAL_DIR } from '../src/router.js';

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return Promise.resolve().then(fn).finally(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
}

function receiptAgent() {
  const dir = mkdtempSync(join(tmpdir(), 'terra-receipt-agent-'));
  const path = join(dir, 'agent.mjs');
  writeFileSync(path, `const prompt=process.argv[2]||'';const line=prompt.split('\\n').find(x=>x.startsWith('TERRARIUM_RESULT='));const expected=JSON.parse(line.slice('TERRARIUM_RESULT='.length));const task=prompt.split('Task:\\n').at(-1).trim();console.log('Summary: '+task);console.log('Changed files: None');console.log('Verification: synthetic');console.log('TERRARIUM_RESULT='+JSON.stringify({...expected,summary:'completed '+task}));`);
  return { command: `${process.execPath} ${path}`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('four parallel top-level runs keep exact tasks and verified contracts', async () => {
  const agent = receiptAgent();
  const tasks = ['alpha unique research', 'beta unique research', 'gamma unique research', 'delta unique research'];
  try {
    const results = await Promise.all(tasks.map((task) => runTerrarium({ task, agent: agent.command, profile: 'minimal', maxDepth: 1, requireTaskContract: true, stream: false })));
    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].ok, true);
      assert.equal(results[i].taskContractStatus, 'verified');
      assert.match(results[i].taskResultSummary, new RegExp(tasks[i]));
      for (let j = 0; j < tasks.length; j++) if (j !== i) assert.doesNotMatch(results[i].taskResultSummary, new RegExp(tasks[j]));
    }
    assert.equal(new Set(results.map((r) => r.runId)).size, 4);
    const journal = readdirSync(JOURNAL_DIR);
    for (let i = 0; i < results.length; i++) {
      const file = journal.find((name) => name.includes(results[i].runId) && name.includes('Completed'));
      assert.ok(file, `missing completion event for ${results[i].runId}`);
      const event = JSON.parse(readFileSync(join(JOURNAL_DIR, file), 'utf8'));
      assert.equal(event.runId, results[i].runId);
      assert.equal(event.task, tasks[i]);
    }
  } finally { agent.cleanup(); }
});

test('maxDepth one / denied spawn leaves no child claim', async () => {
  const parent = `ter_test_denied_${Date.now()}`;
  const claims = join(LOG_DIR, `${parent}.children`);
  await withEnv({ TERRARIUM_RUN_ID: parent, TERRARIUM_DEPTH: '1', TERRARIUM_MAX_DEPTH: '1', TERRARIUM_ALLOW_SPAWN: 'false' }, async () => {
    await assert.rejects(() => runTerrarium({ task: 'denied', dryRun: true, stream: false }), /max depth exceeded|spawn capability denied/);
  });
  assert.equal(existsSync(claims), false);
});

test('failed preparation after claiming releases the child slot', async () => {
  const parent = `ter_test_release_${Date.now()}`;
  const claims = join(LOG_DIR, `${parent}.children`);
  const runId = `ter_test_failed_prepare_${Date.now()}`;
  const mre = join(LOG_DIR, `ter_test_existing_${Date.now()}.mre.log`);
  writeFileSync(mre, 'occupied');
  try {
    await withEnv({ TERRARIUM_RUN_ID: parent, TERRARIUM_DEPTH: '1', TERRARIUM_MAX_DEPTH: '2', TERRARIUM_ALLOW_SPAWN: 'true', TERRARIUM_CHILD_BUDGET: '1' }, async () => {
      await assert.rejects(() => runTerrarium({ task: 'will fail after claim', runId, dryRun: true, stream: false, mreLogPath: mre }), /EEXIST/);
    });
    assert.equal(existsSync(claims), false);
    assert.equal(existsSync(join(LOG_DIR, `${runId}.json`)), false);
    assert.equal(existsSync(join(LOG_DIR, `${runId}.log`)), false);
  } finally { rmSync(mre, { force: true }); rmSync(claims, { recursive: true, force: true }); }
});

test('valid nested spawn consumes exactly one slot', async () => {
  const parent = `ter_test_allowed_${Date.now()}`;
  const claims = join(LOG_DIR, `${parent}.children`);
  try {
    await withEnv({ TERRARIUM_RUN_ID: parent, TERRARIUM_DEPTH: '1', TERRARIUM_MAX_DEPTH: '2', TERRARIUM_ALLOW_SPAWN: 'true', TERRARIUM_CHILD_BUDGET: '1' }, async () => {
      const result = await runTerrarium({ task: 'allowed', dryRun: true, stream: false });
      assert.equal(result.ok, true);
      await assert.rejects(() => runTerrarium({ task: 'second', dryRun: true, stream: false }), /child budget exceeded/);
    });
    assert.equal(existsSync(join(claims, '1')), true);
  } finally { rmSync(claims, { recursive: true, force: true }); }
});

test('descendant scope permits only the caller lineage', async () => {
  const parent = await runTerrarium({ task: 'lineage parent', dryRun: true, stream: false });
  let child;
  const claims = join(LOG_DIR, `${parent.runId}.children`);
  try {
    await withEnv({ TERRARIUM_RUN_ID: parent.runId, TERRARIUM_DEPTH: '1', TERRARIUM_MAX_DEPTH: '2', TERRARIUM_ALLOW_SPAWN: 'true' }, async () => {
      child = await runTerrarium({ task: 'lineage child', dryRun: true, stream: false });
    });
    const sibling = await runTerrarium({ task: 'lineage stranger', dryRun: true, stream: false });
    assert.equal((await getRunStatus({ runId: child.runId, requesterRunId: parent.runId, scope: 'descendants' })).runId, child.runId);
    await assert.rejects(() => getRunStatus({ runId: sibling.runId, requesterRunId: parent.runId, scope: 'descendants' }), /access denied/);
  } finally { rmSync(claims, { recursive: true, force: true }); }
});

test('self-scoped runs cannot inspect sibling status or logs', async () => {
  const a = await runTerrarium({ task: 'scope A', dryRun: true, stream: false });
  const b = await runTerrarium({ task: 'scope B', dryRun: true, stream: false });
  assert.equal((await getRunStatus({ runId: a.runId, requesterRunId: a.runId, scope: 'self' })).runId, a.runId);
  await assert.rejects(() => getRunStatus({ runId: b.runId, requesterRunId: a.runId, scope: 'self' }), /access denied/);
  await assert.rejects(() => readRun({ runId: b.runId, requesterRunId: a.runId, scope: 'self' }), /access denied/);
  await withEnv({ TERRARIUM_RUN_ID: a.runId, TERRARIUM_STATUS_SCOPE: 'self', TERRARIUM_READ_SCOPE: 'self' }, async () => {
    await assert.rejects(() => getRunStatus({ runId: b.runId }), /access denied/);
    await assert.rejects(() => readRun({ runId: b.runId }), /access denied/);
    await assert.rejects(() => getRunStatus({ runId: b.runId, scope: 'all' }), /cannot widen inherited status scope/);
    await assert.rejects(() => getRunStatus({ runId: b.runId, requesterRunId: b.runId, scope: 'self' }), /requester run id does not match inherited lineage/);
  });
});

test('wrong or missing task receipts are not successful', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terra-wrong-agent-'));
  const wrong = join(dir, 'wrong.mjs');
  const missing = join(dir, 'missing.mjs');
  writeFileSync(wrong, `console.log('TERRARIUM_RESULT='+JSON.stringify({runId:'ter_wrong',taskFingerprint:'wrong',nonce:'wrong',summary:'other task'}));`);
  writeFileSync(missing, `console.log('Summary: unrelated success');`);
  try {
    const mismatch = await runTerrarium({ task: 'expected', agent: `${process.execPath} ${wrong}`, requireTaskContract: true, stream: false });
    assert.equal(mismatch.ok, false); assert.equal(mismatch.status, 'inconclusive'); assert.equal(mismatch.taskContractStatus, 'mismatch');
    const absent = await runTerrarium({ task: 'expected', agent: `${process.execPath} ${missing}`, requireTaskContract: true, stream: false });
    assert.equal(absent.ok, false); assert.equal(absent.status, 'inconclusive'); assert.equal(absent.taskContractStatus, 'missing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
