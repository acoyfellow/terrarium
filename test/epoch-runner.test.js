import test from 'node:test';
import assert from 'node:assert/strict';
import { roundAsMemoryTurns } from '../src/epoch-runner.js';

test('round results become bounded memory turns for the next barrier', () => {
  const turns = roundAsMemoryTurns({ results: [{ probeId: 'p', plan: { mechanism: 'm' }, result: { observed: 'o', verdict: 'contained' }, revision: 'a'.repeat(40) }] }, 20);
  assert.deepEqual(turns[0], { turn: 21, scenarioId: 'p', hypothesis: 'm', result: 'o', verdict: 'contained', sourceRevision: 'a'.repeat(40) });
});
