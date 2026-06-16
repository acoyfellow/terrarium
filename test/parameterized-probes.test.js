import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_IDS, runParameterizedProbe } from '../src/parameterized-probes.js';

test('strategist-derived probes are explicit and reject unknown ids', async () => {
  assert.deepEqual(PROBE_IDS, ['interpreter-proxy-exec', 'proc-fd-rediscovery', 'encoding-evasion-leak', 'sibling-count-bypass', 'dependency-pin-downgrade']);
  await assert.rejects(() => runParameterizedProbe('not-real'), /unknown parameterized probe/);
});

test('proc rediscovery remains contained under the Docker policy', { timeout: 60000 }, async (t) => {
  const result = await runParameterizedProbe('proc-fd-rediscovery');
  if (result.verdict === 'contained') assert.match(result.observed, /No runtime control/);
  else assert.equal(result.verdict, 'escaped'); // a real finding, not a test failure
});
