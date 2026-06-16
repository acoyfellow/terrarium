import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyProbe, findDuplicate, sanitizedFinding, verifyProbeFinding } from '../src/finding-pipeline.js';

test('classifies interpreter proxy as clarification, not product escape', () => {
  const c = classifyProbe('interpreter-proxy-exec');
  assert.equal(c.publishIssue, false);
  assert.equal(c.kind, 'boundary-clarification');
});

test('fresh replay produces immutable evidence and dedupe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'terra-findings-'));
  try {
    const finding = await verifyProbeFinding('interpreter-proxy-exec', { findingDir: dir, traceRunId: 'ter_trace' });
    assert.equal(finding.verdict, 'verified-escape');
    assert.equal(finding.fixture, false);
    assert.match(finding.evidenceDigest, /^[a-f0-9]{64}$/);
    assert.equal((await findDuplicate(finding.dedupeSignature, { findingDir: dir })).findingId, finding.findingId);
    const publicValue = sanitizedFinding(finding);
    assert.equal(JSON.stringify(publicValue).includes(finding.path), false);
    assert.equal(publicValue.traceRunId, 'ter_trace');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
