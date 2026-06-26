import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secureAgentEnv } from '../src/secure-agent.js';

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

test('secure agent passes only non-provider environment variables to Pi', () => {
  const env = secureAgentEnv({ PATH: '/bin', HOME: '/tmp/home', LANG: 'C', ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret', AWS_PROFILE: 'prod', PI_MCP_EXTENSION: '/host/extension' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/tmp/home', LANG: 'C' });
});

test('code-mode MCP is fail-closed around the secure workspace tools', () => {
  assert.match(mcp, /createQuickJSSandbox/);
  assert.match(mcp, /expose: SECURE_TOOL_SCHEMAS/);
  assert.match(mcp, /keepNative: \["finish"\]/);
  assert.match(mcp, /maxToolCalls: 60/);
  assert.match(mcp, /audit: "metadata"/);
});
