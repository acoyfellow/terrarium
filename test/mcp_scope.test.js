import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTerrarium } from '../src/core.js';

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
  assert.deepEqual(responses[0].result.tools.map((tool) => tool.name), ['terrarium_spawn', 'terrarium_status', 'terrarium_read']);
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
  ], env);
  assert.deepEqual(responses.find((r) => r.id === 1).result.tools.map((t) => t.name), ['terrarium_status', 'terrarium_read']);
  assert.equal(JSON.parse(toolText(responses.find((r) => r.id === 2))).runId, a.runId);
  assert.match(toolText(responses.find((r) => r.id === 3)), /access denied/);
  assert.match(toolText(responses.find((r) => r.id === 4)), /access denied/);
  assert.match(toolText(responses.find((r) => r.id === 5)), /spawn capability denied/);
});

test('MCP defaults non-dry runs to detached background execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'terra-mcp-background-'));
  const agentPath = join(dir, 'slow.mjs');
  writeFileSync(agentPath, `setTimeout(()=>{},1000);`);
  try {
    const { responses } = await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrarium_spawn', arguments: { task: 'detached default', agent: `${process.execPath} ${agentPath}` } } }]);
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
