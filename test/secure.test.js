import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECURE_PROFILE, runSecureTask } from '../src/secure.js';

const source = readFileSync(new URL('../src/secure.js', import.meta.url), 'utf8');
const containerSource = readFileSync(new URL('../src/secure-container.js', import.meta.url), 'utf8');

test('secure-v1 is explicit, bounded, and never bind-mounts the host repo', () => {
  assert.equal(SECURE_PROFILE.id, 'secure-v1');
  assert.equal(SECURE_PROFILE.network, 'none');
  assert.equal(SECURE_PROFILE.rootFilesystem, 'read-only');
  assert.equal(SECURE_PROFILE.capabilities, 'drop-all');
  assert.equal(SECURE_PROFILE.childBudget, 1);
  assert.ok(SECURE_PROFILE.timeoutMs > 0);
  assert.doesNotMatch(containerSource, /--mount|--volume|-v,/);
  assert.match(containerSource, /docker exec -i.*tar -xf/);
  assert.match(containerSource, /docker.*rm.*-f/s);
});

test('secure task fails closed before Docker for empty work', async () => {
  await assert.rejects(() => runSecureTask({ task: '' }), /secure task required/);
});
