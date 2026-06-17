import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSecureContainer, destroySecureContainer } from '../src/secure-container.js';
import { SecureWorkspace } from '../src/secure-workspace.js';

const fixture = new URL('../fixtures/secure-agent-parser', import.meta.url).pathname;

test('secure workspace edits a disposable copy, runs tests, and leaves host unchanged', { timeout: 60000 }, async () => {
  const original = readFileSync(`${fixture}/parser.js`, 'utf8');
  const secure = createSecureContainer({ cwd: fixture });
  try {
    const workspace = new SecureWorkspace(secure.container);
    assert.ok(workspace.listFiles({}).some((f) => f.path === 'parser.js'));
    assert.match(workspace.readFile({ path: 'parser.js' }).content, /BUG/);
    workspace.writeFile({ path: 'parser.js', content: `export function parsePort(value) {\n const p=Number(value); if(!Number.isInteger(p)||p<1||p>65535) throw new Error('invalid port'); return p;\n}\n` });
    assert.equal(workspace.runTests({}).passed, true);
    assert.deepEqual(workspace.getDiff().changes.map((c) => c.path), ['parser.js']);
    assert.equal(readFileSync(`${fixture}/parser.js`, 'utf8'), original);
  } finally { assert.equal(destroySecureContainer(secure.container), true); }
});

test('secure workspace rejects traversal and protected writes before execution', () => {
  const workspace = new SecureWorkspace('not-used');
  assert.throws(() => workspace.readFile({ path: '../secret' }), /invalid workspace path/);
  assert.throws(() => workspace.writeFile({ path: 'package-lock.json', content: '{}' }), /protected path/);
});
