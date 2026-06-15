import test from 'node:test';
import assert from 'node:assert/strict';
import { readFixturePolicy } from '../src/sandbox.js';

// Regression for verified escape #13: the environment-leak fixture must no longer
// inject its planted canary by default, so the boundary stays contained on replay.
test('issue #13: environment-leak fixture no longer injects the planted canary', async () => {
  const policy = await readFixturePolicy({ variant: 'vulnerable' });
  assert.equal(policy.injectCanary, false);
});
