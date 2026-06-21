import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseTerrarium } from '../src/doctor.js';

test('doctor reports bounded operational diagnostics without process environments', async () => {
  const result = await diagnoseTerrarium();
  for (const field of ['homeWritable', 'logsWritable', 'workspaceWritable', 'routerWritable']) assert.equal(typeof result.checks[field], 'boolean');
  for (const field of ['activeRuns', 'orphanedRuns', 'needsAttentionRuns', 'groups', 'subscribers', 'pendingCallbacks', 'inflightCallbacks', 'staleChildClaims']) assert.equal(typeof result.checks[field], 'number');
  assert.equal(JSON.stringify(result).includes('process.env'), false);
  assert.ok(Array.isArray(result.warnings));
});
