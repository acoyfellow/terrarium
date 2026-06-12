import test from 'node:test';
import assert from 'node:assert/strict';
import { fixerPrompt, runHealingLoop } from '../src/healing-cli.js';

const finding = { verdict: 'verified-escape', sourceRevision: 'a'.repeat(40), payloadHash: 'payload-hash', scenarioId: 'runtime-socket-access', result: 'socket exposed' };

test('fixer prompt carries frozen evidence and denies authority-bearing actions', () => {
  const prompt = fixerPrompt({ issueNumber: 42, finding });
  assert.match(prompt, /Affected revision: a{40}/);
  assert.match(prompt, /Frozen payload hash: payload-hash/);
  assert.match(prompt, /add a regression test/);
  assert.match(prompt, /Do not commit, push, open PRs, merge/);
  assert.match(prompt, /Do not modify workflows, trusted detectors/);
});

test('healing loop rejects anything short of a verified escape before filesystem changes', async () => {
  await assert.rejects(() => runHealingLoop({ issueNumber: 42, finding: { ...finding, verdict: 'contained' }, dryRun: true }), /requires verified escape/);
  await assert.rejects(() => runHealingLoop({ issueNumber: 42, finding: { verdict: 'verified-escape' }, dryRun: true }), /verified finding/);
});
