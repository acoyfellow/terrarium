// Go-vs-TypeScript decision rubric (evidence round shard C): the rubric doc must
// (1) stay a non-deploy decision, (2) keep all eight falsifiable criteria,
// (3) cite five REAL recorded receipts and run IDs that exist on disk, and
// (4) record the Dane operational truth (batch MCP timeout vs durable completion)
// as the deciding C2 signal. These tests stop the evidence from going fictional.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const doc = readFileSync(root + 'docs/GO_VS_TS_DECISION_RUBRIC.md', 'utf8');

test('doc declares itself a non-deploy decision rubric', () => {
  assert.match(doc, /decision rubric/i);
  assert.match(doc, /does not (migrate|move|build|deploy)/i);
  assert.match(doc, /non-deploy/i);
});

test('rubric keeps all eight falsifiable criteria C1..C8', () => {
  for (let i = 1; i <= 8; i++) {
    assert.match(doc, new RegExp(`\\bC${i}\\b`), `criterion C${i} must be present`);
  }
  // falsifiability clause must exist so hand-waved criteria score Neutral.
  assert.match(doc, /falsifiable/i);
  assert.match(doc, /Neutral.?by.?rule/i);
});

test('C7 is a hard gate and C8 is the reversibility tiebreak', () => {
  assert.match(doc, /C7 is a \*\*gate\*\*/i);
  assert.match(doc, /lower-risk reversible/i);
});

test('the five cited receipts exist on disk', () => {
  const ids = [...doc.matchAll(/`(ph-\d{14})`/g)].map((m) => m[1]);
  const unique = [...new Set(ids)];
  assert.equal(unique.length, 5, 'doc must cite exactly five distinct receipts');
  for (const id of unique) {
    const p = root + `receipts/product-loop/${id}.json`;
    assert.ok(existsSync(p), `cited receipt ${id} must exist at ${p}`);
  }
});

test('each cited child run ID is actually recorded in its cited receipt', () => {
  // Pull the rows of the "five real runs" table: receipt id + run id on the same row.
  const rows = [...doc.matchAll(/`(ph-\d{14})`\s*\|\s*`(ter_[0-9]+_[a-z0-9]+)`/g)];
  assert.equal(rows.length, 5, 'must have five receipt->run rows');
  for (const [, receiptId, runId] of rows) {
    const receipt = JSON.parse(
      readFileSync(root + `receipts/product-loop/${receiptId}.json`, 'utf8'),
    );
    const runIds = (receipt.childRuns || []).map((c) => c.runId);
    assert.ok(
      runIds.includes(runId),
      `run ${runId} must be a real childRun of ${receiptId} (has: ${runIds.join(', ')})`,
    );
  }
});

test('Dane operational truth is recorded and matches the receipts (batch ok:false, runs complete)', () => {
  assert.match(doc, /Dane operational truth/i);
  assert.match(doc, /spawn_batch.*(ok.?:?\s*false|times out)/is);
  assert.match(doc, /durable runs.*complete/is);

  // Cross-check the claim against the real receipts: every cited receipt must have a
  // spawn_batch command with ok:false AND at least one childRun with status "done".
  const ids = [...new Set([...doc.matchAll(/`(ph-\d{14})`/g)].map((m) => m[1]))];
  for (const id of ids) {
    const r = JSON.parse(readFileSync(root + `receipts/product-loop/${id}.json`, 'utf8'));
    const batchFailed = (r.commands || []).some(
      (c) => /spawn_batch/.test(c.command) && c.ok === false,
    );
    const aRunCompleted = (r.childRuns || []).some((c) => c.status === 'done');
    assert.ok(batchFailed, `${id} must record a spawn_batch command with ok:false`);
    assert.ok(aRunCompleted, `${id} must record at least one completed (done) run`);
  }
});

test('recommendation is keep-TS-now + bounded inert Go port, driven by C2', () => {
  assert.match(doc, /Do not rewrite the core in Go now/i);
  assert.match(doc, /GO_CORE_MIGRATION\.md/);
  assert.match(doc, /C2/);
  assert.match(doc, /decouple durable run lifetime/i);
});

test('rubric cross-references the governing docs and honors non-goals', () => {
  assert.match(doc, /CORE_PRODUCT_DECISION\.md/);
  assert.match(doc, /ARCHITECTURE\.md/);
  assert.match(doc, /PULSE\.md/);
  assert.match(doc, /non-goal/i);
});
