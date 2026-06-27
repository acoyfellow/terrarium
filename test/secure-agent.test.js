import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secureAgentEnv } from '../src/secure-agent.js';

const source = readFileSync(new URL('../src/secure-agent.js', import.meta.url), 'utf8');
const mcp = readFileSync(new URL('../src/secure-mcp.js', import.meta.url), 'utf8');
const doc = readFileSync(new URL('../docs/SECURE_V1.md', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../src/secure-workspace.js', import.meta.url), 'utf8');

test('secure agent keeps Pi outside and disables host built-in tools', () => {
  assert.match(source, /--no-builtin-tools/);
  assert.match(source, /--tools", "mcp/);
  assert.match(source, /--mode", "json/);
  assert.match(source, /TERRARIUM_SECURE_CONTAINER/);
  assert.match(source, /agent invoked a tool outside Terrarium secure MCP/);
  assert.doesNotMatch(source, /model.*result =|result = .*model/);
});

test('secure agent passes only non-provider environment variables to Pi', () => {
  const env = secureAgentEnv({ PATH: '/bin', HOME: '/tmp/home', LANG: 'C', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', AWS_PROFILE: 'prod', PI_MCP_EXTENSION: '/host/extension' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/tmp/home', LANG: 'C' });
});

test('SECURE_V1 doc tells the truth about the two-layer tool surface', () => {
  // The host-visible audit allowlist and the doc must name the same tools, so a
  // reader auditing a receipt's toolAudit sees exactly what the doc promised.
  for (const hostTool of ['search', 'execute', 'finish']) {
    assert.match(source, new RegExp(`"${hostTool}"`), `audit allowlist names ${hostTool}`);
    assert.match(doc, new RegExp(`\`${hostTool}\``), `doc names host tool ${hostTool}`);
  }
  // The six brokered workspace tools must be named in the doc and actually exist
  // as exposed schemas in the workspace broker.
  for (const brokered of ['list_files', 'read_file', 'search_text', 'write_file', 'run_tests', 'get_diff']) {
    assert.match(workspace, new RegExp(`name: "${brokered}"`), `workspace exposes ${brokered}`);
    assert.match(doc, new RegExp(`\`${brokered}\``), `doc names brokered tool ${brokered}`);
  }
  // finish must stay native (not exposed into the QuickJS sandbox).
  assert.match(mcp, /keepNative: \["finish"\]/);
});

test('code-mode MCP is fail-closed around the secure workspace tools', () => {
  assert.match(mcp, /createQuickJSSandbox/);
  assert.match(mcp, /expose: SECURE_TOOL_SCHEMAS/);
  assert.match(mcp, /keepNative: \["finish"\]/);
  assert.match(mcp, /maxToolCalls: 60/);
  assert.match(mcp, /audit: "metadata"/);
});
