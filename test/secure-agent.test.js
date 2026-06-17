import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/secure-agent.js', import.meta.url), 'utf8');
const mcp = readFileSync(new URL('../src/secure-mcp.js', import.meta.url), 'utf8');

test('secure agent keeps Pi outside and disables host built-in tools', () => {
  assert.match(source, /--no-builtin-tools/);
  assert.match(source, /--tools", "mcp/);
  assert.match(source, /--mode", "json/);
  assert.match(source, /TERRARIUM_SECURE_CONTAINER/);
  assert.match(source, /agent invoked a tool outside Terrarium secure MCP/);
  assert.doesNotMatch(source, /model.*result =|result = .*model/);
});

test('code-mode MCP is fail-closed around the secure workspace tools', () => {
  assert.match(mcp, /createQuickJSSandbox/);
  assert.match(mcp, /expose: SECURE_TOOL_SCHEMAS/);
  assert.match(mcp, /keepNative: \["finish"\]/);
  assert.match(mcp, /maxToolCalls: 60/);
  assert.match(mcp, /audit: "metadata"/);
});
