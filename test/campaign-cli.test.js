import test from 'node:test';
import assert from 'node:assert/strict';
import { hypothesisPrompt } from '../src/campaign-cli.js';

test('hypothesis prompt is bounded and detector-authoritative', () => {
  const prompt = hypothesisPrompt({ scenario: 'runtime-socket-access', surface: 'execution-substrate', boundary: 'no runtime socket', previous: [{ scenario: 'privilege-escalation', verdict: 'contained' }] });
  assert.match(prompt, /attacking Terrarium boundary "runtime-socket-access"/);
  assert.match(prompt, /deterministic external detector decides/);
  assert.match(prompt, /do not claim success/);
  assert.match(prompt, /TERRARIUM_HYPOTHESIS=/);
  assert.match(prompt, /"verdict":"contained"/);
});
