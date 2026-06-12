import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReplayBinding, changedPathsFromPatch, patchDigest, validateFixPatch } from '../src/fix-policy.js';

const revision = 'a'.repeat(40);
const patch = `diff --git a/src/example.js b/src/example.js
index 111..222 100644
--- a/src/example.js
+++ b/src/example.js
@@ -1 +1 @@
-export const safe = false;
+export const safe = true;
diff --git a/test/example.test.js b/test/example.test.js
new file mode 100644
--- /dev/null
+++ b/test/example.test.js
@@ -0,0 +1 @@
+test('frozen regression', () => {});
`;

test('accepts a branch-bound fix with a regression test', () => {
  const result = validateFixPatch({ patch, baseRevision: revision, expectedBaseRevision: revision });
  assert.deepEqual(result.paths, ['src/example.js', 'test/example.test.js']);
  assert.equal(result.patchDigest, patchDigest(patch));
  assert.match(result.patchDigest, /^[a-f0-9]{64}$/);
});

test('rejects detector, workflow, evidence-policy, and test weakening', () => {
  for (const path of ['src/sandbox.js', 'src/public-ledger.js', 'src/fix-policy.js', 'test/sandbox.test.js', '.github/workflows/replay-fixture-fix.yml', 'THREAT_MODEL.md', 'wrangler.jsonc']) {
    const hostile = `${patch}\ndiff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+weakened\n`;
    assert.throws(() => validateFixPatch({ patch: hostile, baseRevision: revision, expectedBaseRevision: revision }), /protected path/);
  }
});

test('rejects missing regression, wrong base, and credential insertion', () => {
  const noTest = patch.split('diff --git a/test/')[0];
  assert.throws(() => validateFixPatch({ patch: noTest, baseRevision: revision, expectedBaseRevision: revision }), /regression test/);
  assert.throws(() => validateFixPatch({ patch, baseRevision: 'b'.repeat(40), expectedBaseRevision: revision }), /base revision/);
  assert.throws(() => validateFixPatch({ patch: patch + '\n+token=ghp_abcdefghijklmnopqrstuvwxyz123456', baseRevision: revision, expectedBaseRevision: revision }), /credential-like/);
});

test('binds replay to frozen payload, detector, and affected revision', () => {
  const binding = { findingPayloadHash: 'payload-1', replayPayloadHash: 'payload-1', findingScenarioId: 'scenario-1', replayScenarioId: 'scenario-1', findingRevision: revision, patchBaseRevision: revision };
  assert.equal(assertReplayBinding(binding), true);
  assert.throws(() => assertReplayBinding({ ...binding, replayPayloadHash: 'easier-payload' }), /frozen finding payload/);
  assert.throws(() => assertReplayBinding({ ...binding, replayScenarioId: 'weaker-detector' }), /finding detector/);
  assert.throws(() => assertReplayBinding({ ...binding, patchBaseRevision: 'b'.repeat(40) }), /affected revision/);
});

test('parses changed paths without trusting patch prose', () => {
  assert.deepEqual(changedPathsFromPatch('attacker says src/sandbox.js is safe'), []);
});
