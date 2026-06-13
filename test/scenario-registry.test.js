import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMPAIGN_SCENARIO_IDS, resolveCampaignScenario, scenarioCatalog, SCENARIO_SURFACES } from '../src/scenario-registry.js';
import { SCENARIO_IDS } from '../src/sandbox.js';

test('campaign registry unifies execution-substrate and lab surfaces', () => {
  for (const id of SCENARIO_IDS) assert.equal(SCENARIO_SURFACES[id].surface, 'execution-substrate');
  assert.equal(SCENARIO_SURFACES['lab-env-canary'].surface, 'lab-capability');
  assert.ok(CAMPAIGN_SCENARIO_IDS.includes('runtime-socket-access'));
  assert.ok(CAMPAIGN_SCENARIO_IDS.includes('lab-env-canary'));
});

test('every scenario exposes a contract and a runnable detector', () => {
  for (const entry of scenarioCatalog()) {
    assert.equal(typeof entry.boundary, 'string');
    assert.ok(entry.boundary.length > 0);
    assert.match(entry.backend, /^(docker|lab)$/);
    assert.equal(typeof resolveCampaignScenario(entry.id).run, 'function');
  }
  assert.throws(() => resolveCampaignScenario('not-real'), /unknown campaign scenario/);
});
