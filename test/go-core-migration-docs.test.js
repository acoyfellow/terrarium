// Go core migration shard 4: the migration doc must record the agreed target
// split — Go core owns receipts/process supervision/batch/sweeps; TypeScript
// adapters and Worker Pulse stay TypeScript. These tests pin that split so the
// doc cannot silently drift from the decision.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const doc = readFileSync(root + 'docs/GO_CORE_MIGRATION.md', 'utf8');

test('doc declares itself a non-deploy planning skeleton', () => {
  assert.match(doc, /target shape/i);
  assert.match(doc, /planning skeleton/i);
  assert.match(doc, /not a deploy plan|no runtime is migrated|does not .* change deploy/i);
});

test('Go core owns receipts, process supervision, batch, and sweeps', () => {
  const goSection = doc.slice(doc.indexOf('### Go core owns'), doc.indexOf('### TypeScript adapters'));
  assert.ok(goSection.length > 0, 'must have a "Go core owns" section');
  for (const owned of ['Receipts', 'Process supervision', 'Batch', 'Sweeps']) {
    assert.match(goSection, new RegExp(`\\*\\*${owned}\\*\\*`, 'i'), `Go core must own ${owned}`);
  }
});

test('TypeScript adapters remain TypeScript', () => {
  assert.match(doc, /TypeScript adapters remain TypeScript/i);
  const adapters = doc.slice(doc.indexOf('### TypeScript adapters'), doc.indexOf('### Worker Pulse'));
  for (const adapter of ['MCP', 'CLI', 'Pi']) {
    assert.ok(adapters.includes(adapter), `adapter section must mention ${adapter}`);
  }
});

test('Worker Pulse remains TypeScript and the Go core does not run in the Worker', () => {
  assert.match(doc, /Worker Pulse remains TypeScript/i);
  const pulse = doc.slice(doc.indexOf('### Worker Pulse'));
  assert.match(pulse, /PulseRouter/);
  assert.match(pulse, /Go core does not run inside the Worker/i);
});

test('migration preserves the core invariants', () => {
  assert.match(doc, /Exit 0 alone is never success/i);
  assert.match(doc, /one child process/i);
  assert.match(doc, /terrarium_spawn.*terrarium_status.*terrarium_read/s);
});

test('ARCHITECTURE.md or CORE_PRODUCT_DECISION.md is cross-referenced', () => {
  assert.match(doc, /ARCHITECTURE\.md/);
  assert.match(doc, /CORE_PRODUCT_DECISION\.md/);
  assert.match(doc, /PULSE\.md/);
});
