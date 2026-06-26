import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertPublicSummary, createIterationReceipt, reconcileOuterLoop } from '../scripts/product-loop.mjs';

function validateReceipt(receipt) {
  assert.equal(receipt.schema, 'terrarium.product-loop.receipt.v0.1');
  assert.match(receipt.iterationId, /^ph-\d{14}$/);
  assert.deepEqual(receipt.phases, ['OBSERVE', 'SELECT', 'EXECUTE', 'VERIFY', 'RECORD', 'PUBLIC_SUMMARIZE', 'OPTIONAL_DEPLOY']);
  assert.ok(receipt.selectedWork?.kind);
  assert.equal(typeof receipt.health?.buildOk, 'boolean');
  assert.ok(Array.isArray(receipt.commands));
  assert.ok(receipt.publicSummary);
  validatePublicSummary(receipt.publicSummary);
}

function validatePublicSummary(summary) {
  assert.equal(summary.contentKind, 'product-summary');
  assert.equal(typeof summary.evidenceClaim, 'boolean');
  if (summary.evidenceClaim) assert.ok(summary.evidenceRef, 'evidenceClaim true requires evidenceRef');
  const serialized = JSON.stringify(summary);
  for (const forbidden of ['privateRunMetadata', 'task', 'prompt', 'cwd', 'logPath', 'output']) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, `public summary leaks ${forbidden}`);
  }
}

test('outer loop reconciler checks the three roles without spawning children', () => {
  const result = reconcileOuterLoop({ roles: [
    { role: 'investigator', task: 'Diagnose one bounded failure without editing files.' },
    { role: 'implementer', task: 'Implement the selected small fix.' },
    { role: 'reviewer', task: 'Review the patch and verification evidence.' },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.spawnsChildren, false);
  assert.deepEqual(result.errors, []);
});

test('outer loop reconciler rejects incomplete and duplicate plans', () => {
  const result = reconcileOuterLoop({ roles: [
    { role: 'investigator', task: 'Diagnose.' },
    { role: 'investigator', task: '' },
  ] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /exactly 3 roles/);
  assert.match(result.errors.join('\n'), /missing roles: implementer, reviewer/);
  assert.match(result.errors.join('\n'), /duplicate roles: investigator/);
  assert.match(result.errors.join('\n'), /missing bounded tasks/);
});

test('product loop receipt schema separates public summary from private details', () => {
  validateReceipt({
    schema: 'terrarium.product-loop.receipt.v0.1',
    iterationId: 'ph-20260625203000',
    phases: ['OBSERVE', 'SELECT', 'EXECUTE', 'VERIFY', 'RECORD', 'PUBLIC_SUMMARIZE', 'OPTIONAL_DEPLOY'],
    selectedWork: { kind: 'runner-hardening', reason: 'example' },
    health: { buildOk: true, validationOk: true, repoCleanAtStart: true },
    commands: [{ command: 'npm test', ok: true }],
    publicSummary: {
      iterationId: 'ph-20260625203000',
      contentKind: 'product-summary',
      evidenceClaim: true,
      evidenceRef: 'commit:abc123',
      title: 'Runner hardening',
      summary: 'A verified product change happened.',
    },
  });
});

test('public evidence claims require a typed, checkable evidence reference', () => {
  for (const evidenceRef of [
    'commit:abc1234',
    'terrarium-run:ter_20260626085721563_5zh5ya',
    'test:test/product-loop.test.js',
    'replay:fixture-environment-leak',
  ]) {
    assert.doesNotThrow(() => assertPublicSummary({ iterationId: 'ph-20260625203000', evidenceClaim: true, evidenceRef }));
  }
  for (const evidenceRef of [
    undefined,
    '',
    'trust me',
    'commit:xyz',
    'commit:abc1234\nreplay:forged',
    'terrarium-run:not-a-run',
    'terrarium-run:ter_20260626085721563_5zh5ya/../../private',
    'test:../private',
    'replay:https://attacker.invalid/proof',
  ]) {
    assert.throws(
      () => assertPublicSummary({ iterationId: 'ph-20260625203000', evidenceClaim: true, evidenceRef }),
      /checkable evidenceRef/,
    );
  }
});

test('public campaign keeps agent/model column without publishing model identity', async () => {
  const manifest = JSON.parse(await readFile(new URL('../app/public/campaign/manifest.json', import.meta.url), 'utf8'));
  for (const turn of manifest.turns) assert.equal(turn.agentModel, 'not published', `turn ${turn.turn} must not publish model identity`);
});

test('dry run evaluates health without writing receipts', async () => {
  const result = await createIterationReceipt({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.receipt.health.validationOk, true);
  assert.equal(result.receipt.commands.length, 3);
});

test('public campaign turns cannot claim evidence without checkable evidence metadata', async () => {
  const manifest = JSON.parse(await readFile(new URL('../app/public/campaign/manifest.json', import.meta.url), 'utf8'));
  for (const turn of manifest.turns) {
    assert.ok(['product-iteration', 'product-summary'].includes(turn.contentKind), `unexpected contentKind for turn ${turn.turn}`);
    if (turn.evidenceClaim === true) {
      assert.ok(turn.evidence?.executionId || turn.evidenceRef, `turn ${turn.turn} claims evidence without evidence ref`);
    }
  }
});
