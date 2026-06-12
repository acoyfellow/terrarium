import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replayAndMerge } from '../src/replay-gate.js';

const source = readFileSync(new URL('../src/replay-gate.js', import.meta.url), 'utf8');

test('replay gate orders trusted checks before autonomous merge', () => {
  const patch = source.indexOf('validateFixPatch(');
  const binding = source.indexOf('assertReplayBinding(');
  const tests = source.indexOf('command("npm", ["test"]');
  const replay = source.indexOf('runHostileLabScenario(');
  const verdict = source.indexOf('frozen attack remains reproducible');
  const merge = source.indexOf('"pr", "merge"');
  assert.ok(patch < binding && binding < tests && tests < replay && replay < verdict && verdict < merge);
  assert.match(source, /finding\.privatePayloadBody/);
  assert.doesNotMatch(source, /finding\.publicTurn.*body/);
  assert.match(source, /--squash/);
  assert.match(source, /--delete-branch/);
});

test('replay gate fails closed before side effects for invalid findings', async () => {
  await assert.rejects(() => replayAndMerge({ prNumber: 1, finding: { verdict: 'contained' } }), /requires verified escape/);
  await assert.rejects(() => replayAndMerge({ prNumber: 0, finding: { verdict: 'verified-escape' } }), /valid PR number/);
});
