import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIterationReceipt } from '../scripts/product-loop.mjs';

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
