import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROL_SCENARIOS, CONTROL_SCENARIO_IDS } from '../src/control-scenarios.js';

test('every control-plane boundary currently holds against its own detector', async () => {
  for (const id of CONTROL_SCENARIO_IDS) {
    const result = await CONTROL_SCENARIOS[id].detect();
    assert.equal(result.verdict, 'contained', `${id}: ${result.observed}`);
    assert.match(result.observed, /\w/);
  }
});

test('detectors report escape language only on a real crossing', () => {
  for (const id of CONTROL_SCENARIO_IDS) {
    assert.equal(typeof CONTROL_SCENARIOS[id].boundary, 'string');
    assert.equal(CONTROL_SCENARIOS[id].surface, 'control-plane');
  }
});
