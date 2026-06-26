import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTerrarium } from '../src/core.js';
import { JOURNAL_DIR, MAILBOXES_DIR, SUBSCRIBERS_DIR } from '../src/router.js';

const MCP_PATH = fileURLToPath(new URL('../src/mcp.js', import.meta.url));

function rpc(messages, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => out += d); child.stderr.on('data', (d) => err += d);
    child.on('error', reject); child.on('close', () => resolve({ responses: out.split('\n').filter(Boolean).map(JSON.parse), stderr: err }));
    for (const message of messages) child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.end();
    setTimeout(() => child.kill(), 20000).unref();
  });
}

function toolText(response) { return response.result?.content?.[0]?.text || ''; }

test('top-level MCP keeps the stable three-tool surface', async () => {
  const { responses } = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  const names = responses[0].result.tools.map((tool) => tool.name);
  // Stable primitives remain present and ordered; additive tools may interleave.
  assert.ok(names.includes('terrarium_spawn'));
  assert.ok(names.includes('terrarium_status'));
  assert.ok(names.includes('terrarium_read'));
  assert.ok(names.indexOf('terrarium_spawn') < names.indexOf('terrarium_status'));
  assert.ok(names.indexOf('terrarium_status') < names.indexOf('terrarium_read'));
  assert.ok(names.includes('terrarium_spawn_batch'));
  const spawnSchema = responses[0].result.tools.find((tool) => tool.name === 'terrarium_spawn').inputSchema;
  const batchSchema = responses[0].result.tools.find((tool) => tool.name === 'terrarium_spawn_batch').inputSchema;
  assert.deepEqual(spawnSchema.properties.isolation.enum, ['none', 'copy', 'worktree']);
  assert.deepEqual(batchSchema.properties.jobs.items.properties.isolation.enum, ['none', 'copy', 'worktree']);
  assert.ok(names.includes('terrarium_cancel'));
  assert.ok(names.includes('terrarium_group'));
  assert.ok(names.includes('terrarium_callbacks'));
  assert.ok(names.includes('terrarium_doctor'));
});

test('child MCP removes spawn and denies sibling status/read', async () => {
  const a = await runTerrarium({ task: 'scope owner', dryRun: true, stream: false });
  const b = await runTerrarium({ task: 'scope sibling', dryRun: true, stream: false });
  const env = { TERRARIUM_RUN_ID: a.runId, TERRARIUM_ALLOW_SPAWN: 'false', TERRARIUM_STATUS_SCOPE: 'self', TERRARIUM_READ_SCOPE: 'self' };
  const { responses } = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terrarium_status', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terrarium_status', arguments: { runId: b.runId } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'terrarium_read', arguments: { runId: b.runId } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'terrarium_spawn', arguments: { task: 'nope', dryRun: true } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'subscribe', subscriberId: `sub_${a.runId}`, runIds: [a.runId] } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'subscribe', subscriberId: `sub_bad_${a.runId}`, runIds: [b.runId] } } },
  ], env);
  const childNames = responses.find((r) => r.id === 1).result.tools.map((t) => t.name);
  assert.deepEqual(childNames, ['terrarium_status', 'terrarium_read', 'terrarium_cancel', 'terrarium_group', 'terrarium_callbacks']);
  assert.ok(!childNames.includes('terrarium_spawn_batch'), 'denied child must not see batch fan-out');
  assert.equal(JSON.parse(toolText(responses.find((r) => r.id === 2))).runId, a.runId);
  assert.match(toolText(responses.find((r) => r.id === 3)), /access denied/);
  assert.match(toolText(responses.find((r) => r.id === 4)), /access denied/);
  assert.match(toolText(responses.find((r) => r.id === 5)), /spawn capability denied/);
  assert.equal(JSON.parse(toolText(responses.find((r) => r.id === 6))).ownerRunId, a.runId);
  assert.match(toolText(responses.find((r) => r.id === 7)), /callback run access denied/);
  rmSync(join(MAILBOXES_DIR, `sub_${a.runId}`), { recursive: true, force: true });
  rmSync(join(SUBSCRIBERS_DIR, `sub_${a.runId}.json`), { force: true });
});

test('child MCP denies sibling cancel, callbacks, and group access', async () => {
  const a = await runTerrarium({ task: 'scope group owner', dryRun: true, stream: false });
  const b = await runTerrarium({ task: 'scope group sibling', dryRun: true, stream: false });
  const env = { TERRARIUM_RUN_ID: a.runId, TERRARIUM_ALLOW_SPAWN: 'false', TERRARIUM_STATUS_SCOPE: 'self', TERRARIUM_READ_SCOPE: 'self' };
  const groupId = `grp_scope_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const top = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'create', groupId, runIds: [b.runId] } } }]);
  assert.equal(JSON.parse(toolText(top.responses[0])).groupId, groupId);
  const { responses } = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_cancel', arguments: { runId: b.runId } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'recover', runId: b.runId } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'status', groupId, verbose: true } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'read', groupId } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'cancel', groupId } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'create', groupId: `${groupId}_new`, runIds: [b.runId] } } },
  ], env);
  for (const id of [1, 2]) assert.match(toolText(responses.find((r) => r.id === id)), /access denied/);
  assert.match(toolText(responses.find((r) => r.id === 3)), /group access denied/);
  assert.match(toolText(responses.find((r) => r.id === 4)), /group access denied/);
  assert.doesNotMatch(toolText(responses.find((r) => r.id === 4)), new RegExp(b.runId));
  assert.match(toolText(responses.find((r) => r.id === 5)), /group access denied/);
  assert.match(toolText(responses.find((r) => r.id === 6)), /access denied/);
  rmSync(join(process.env.TERRARIUM_HOME || join(process.env.HOME, '.terrarium'), 'groups', `${groupId}.json`), { force: true });
});

test('child MCP group status does not leak aggregate completion or ok through inaccessible members', async () => {
  const a = await runTerrarium({ task: 'scope aggregate owner', dryRun: true, stream: false });
  const b = await runTerrarium({ task: 'scope aggregate sibling', dryRun: true, stream: false });
  const groupId = `grp_scope_aggregate_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const top = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'create', groupId, runIds: [a.runId, b.runId] } } }]);
  assert.equal(JSON.parse(toolText(top.responses[0])).groupId, groupId);
  try {
    const env = { TERRARIUM_RUN_ID: a.runId, TERRARIUM_ALLOW_SPAWN: 'false', TERRARIUM_STATUS_SCOPE: 'self', TERRARIUM_READ_SCOPE: 'self' };
    const { responses } = await rpc([{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'status', groupId } } }], env);
    const text = toolText(responses[0]);
    assert.match(text, /group access denied/);
    assert.doesNotMatch(text, /"complete"|"ok"|"counts"|scope aggregate sibling/);
  } finally {
    rmSync(join(process.env.TERRARIUM_HOME || join(process.env.HOME, '.terrarium'), 'groups', `${groupId}.json`), { force: true });
  }
});

test('group status/read/cancel deny mixed missing and inaccessible membership without leaking partial output', async () => {
  const owner = await runTerrarium({ task: 'mixed group owner', dryRun: true, stream: false });
  const sibling = await runTerrarium({ task: 'mixed group sibling', dryRun: true, stream: false });
  const missingRunId = `ter_${'e'.repeat(20)}`;
  const groupId = `grp_mixed_scope_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const groupsDir = join(process.env.TERRARIUM_HOME || join(process.env.HOME, '.terrarium'), 'groups');
  const groupPath = join(groupsDir, `${groupId}.json`);
  writeFileSync(groupPath, JSON.stringify({ version: 1, groupId, label: 'mixed', runIds: [owner.runId, missingRunId, sibling.runId], createdAt: new Date().toISOString() }));
  try {
    const env = { TERRARIUM_RUN_ID: owner.runId, TERRARIUM_ALLOW_SPAWN: 'false', TERRARIUM_STATUS_SCOPE: 'self', TERRARIUM_READ_SCOPE: 'self' };
    const { responses } = await rpc(['status', 'read', 'cancel'].map((action, index) => ({
      jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action, groupId } },
    })), env);
    for (const response of responses) {
      const text = toolText(response);
      assert.match(text, /group access denied/);
      assert.doesNotMatch(text, new RegExp(`${owner.runId}|${sibling.runId}|${missingRunId}|"counts"|"cancelled"`));
    }
  } finally {
    rmSync(groupPath, { force: true });
  }
});

test('MCP group status is concise by default and verbose only on request', async () => {
  const a = await runTerrarium({ task: 'concise group member', dryRun: true, stream: false });
  const groupId = `grp_concise_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'create', groupId, label: 'concise', runIds: [a.runId] } } }]);
    const { responses } = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'status', groupId } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terrarium_group', arguments: { action: 'status', groupId, verbose: true } } },
    ]);
    const concise = JSON.parse(toolText(responses.find((r) => r.id === 1)));
    const verbose = JSON.parse(toolText(responses.find((r) => r.id === 2)));
    assert.equal(concise.createdAt, undefined);
    assert.equal(concise.runs[0].startedAt, undefined);
    assert.equal(typeof verbose.createdAt, 'string');
    assert.equal(typeof verbose.runs[0].startedAt, 'string');
  } finally {
    rmSync(join(process.env.TERRARIUM_HOME || join(process.env.HOME, '.terrarium'), 'groups', `${groupId}.json`), { force: true });
  }
});

test('child callback recover and subscriber status enforce lineage ownership', async () => {
  const a = await runTerrarium({ task: 'callback scope owner', dryRun: true, stream: false });
  const b = await runTerrarium({ task: 'callback scope sibling', dryRun: true, stream: false });
  const subscriberId = `sub_callback_scope_${a.runId}`;
  const env = { TERRARIUM_RUN_ID: a.runId, TERRARIUM_ALLOW_SPAWN: 'false', TERRARIUM_STATUS_SCOPE: 'self', TERRARIUM_READ_SCOPE: 'self' };
  try {
    const { responses } = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'subscribe', subscriberId, runIds: [a.runId] } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'recover', runId: a.runId } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'recover', runId: b.runId } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'status', subscriberId } } },
    ], env);
    assert.equal(JSON.parse(toolText(responses.find((r) => r.id === 2))).runId, a.runId);
    assert.match(toolText(responses.find((r) => r.id === 3)), /access denied/);
    assert.match(toolText(responses.find((r) => r.id === 4)), /ENOENT|subscriberId/);
  } finally {
    rmSync(join(MAILBOXES_DIR, subscriberId), { recursive: true, force: true });
    rmSync(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
  }
});

test('callback status/claim narrow arguments and reject missing identifiers without leaking sibling data', async () => {
  const owner = await runTerrarium({ task: 'callback narrowing owner', dryRun: true, stream: false });
  const sibling = await runTerrarium({ task: 'callback narrowing sibling secret', dryRun: true, stream: false });
  const subscriberId = `sub_callback_narrow_${owner.runId}`;
  const env = { TERRARIUM_RUN_ID: owner.runId, TERRARIUM_ALLOW_SPAWN: 'false', TERRARIUM_STATUS_SCOPE: 'self', TERRARIUM_READ_SCOPE: 'self' };
  try {
    await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'subscribe', subscriberId, runIds: [owner.runId] } } }], env);
    const { responses } = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'status', subscriberId, runId: sibling.runId, runIds: [sibling.runId], eventId: 'evt_sibling', limit: 999, olderThanMs: 0 } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'claim', subscriberId, runId: sibling.runId, runIds: [sibling.runId], eventId: 'evt_sibling', limit: 1, olderThanMs: 0 } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'status' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'claim' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'recover' } } },
    ], env);
    for (const id of [1, 2]) {
      const text = toolText(responses.find((r) => r.id === id));
      assert.doesNotMatch(text, new RegExp(`${sibling.runId}|callback narrowing sibling secret|evt_sibling`));
    }
    assert.match(toolText(responses.find((r) => r.id === 3)), /status requires subscriberId/);
    assert.match(toolText(responses.find((r) => r.id === 4)), /claim requires subscriberId/);
    assert.match(toolText(responses.find((r) => r.id === 5)), /recover requires runId/);
  } finally {
    rmSync(join(MAILBOXES_DIR, subscriberId), { recursive: true, force: true });
    rmSync(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
  }
});

test('MCP concrete callback subscribe recovers completion that raced ahead', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const runId = `ter_mcp_callback_${suffix}`;
  const subscriberId = `sub_mcp_callback_${suffix}`;
  const run = await runTerrarium({ runId, task: 'callback race', dryRun: true, stream: false });
  assert.equal(run.status, 'done');
  try {
    const subscribed = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'subscribe', subscriberId, runIds: [runId] } } },
    ]);
    const subscription = JSON.parse(toolText(subscribed.responses.find((r) => r.id === 1)));
    assert.equal(subscription.replayed, 1);
    assert.equal(subscription.recovered[0].duplicate, true);
    const claimedResponse = await rpc([
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terrarium_callbacks', arguments: { action: 'claim', subscriberId } } },
    ]);
    const claimed = JSON.parse(toolText(claimedResponse.responses.find((r) => r.id === 2)));
    assert.deepEqual(claimed.events.map((event) => event.runId), [runId]);
  } finally {
    rmSync(join(MAILBOXES_DIR, subscriberId), { recursive: true, force: true });
    rmSync(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
    await rm(join(JOURNAL_DIR, `evt_${runId}_Completed.json`), { force: true });
  }
});

test('MCP supports opt-in detached background execution without changing the synchronous default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terra-mcp-background-'));
  const agentPath = join(dir, 'slow.mjs');
  writeFileSync(agentPath, `setTimeout(()=>{},1000);`);
  try {
    const { responses } = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_spawn', arguments: { task: 'detached default', agent: `${process.execPath} ${agentPath}` } } }], { TERRARIUM_BACKGROUND_BY_DEFAULT: 'true' });
    const result = JSON.parse(toolText(responses[0]));
    assert.equal(result.background, true);
    assert.match(result.runId, /^ter_/);
    assert.equal(result.status, 'running');
    await new Promise((resolve) => setTimeout(resolve, 1200));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP accepts a correctly correlated synchronous run/task receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terra-mcp-contract-'));
  const agentPath = join(dir, 'correct.mjs');
  writeFileSync(agentPath, `const p=process.argv[2];const l=p.split('\\n').find(x=>x.startsWith('TERRARIUM_RESULT='));const e=JSON.parse(l.slice('TERRARIUM_RESULT='.length));console.log('TERRARIUM_RESULT='+JSON.stringify({...e,summary:'completed expected task'}));`);
  try {
    const { responses } = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_spawn', arguments: { task: 'expected task', agent: `${process.execPath} ${agentPath}`, background: false } } }]);
    const result = JSON.parse(toolText(responses[0]));
    assert.equal(result.ok, true);
    assert.equal(result.taskContractStatus, 'verified');
    assert.equal(result.retryCount, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MCP task mismatch retries are bounded and terminate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terra-mcp-retry-'));
  const agentPath = join(dir, 'missing.mjs');
  writeFileSync(agentPath, `console.log('Summary: wrong task');`);
  try {
    const { responses } = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_spawn', arguments: { task: 'expected', agent: `${process.execPath} ${agentPath}`, maxRetries: 2 } } }]);
    const result = JSON.parse(toolText(responses[0]));
    assert.equal(result.ok, false);
    assert.equal(result.taskContractStatus, 'missing');
    assert.equal(result.retryCount, 2);
    assert.equal(result.attemptRunIds.length, 3);
    const invalid = await rpc([{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'terrarium_spawn', arguments: { task: 'expected', agent: `${process.execPath} ${agentPath}`, maxRetries: 3 } } }]);
    assert.match(toolText(invalid.responses[0]), /maxRetries/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
