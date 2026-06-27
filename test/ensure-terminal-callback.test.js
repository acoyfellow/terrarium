import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureTerminalCallback, metadataPath, LOG_DIR } from '../src/core.js';

// These tests exercise the callback-recovery backbone (terrarium_callbacks
// recover). They run hermetically against the per-test TERRARIUM_HOME set by
// scripts/test-isolated.mjs, writing run logs directly under LOG_DIR.

async function writeRunMetadata(runId, meta) {
  const path = metadataPath(runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`);
}

const suffix = () => `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const RUN_ID = `ter_active_${suffix()}`;

test('ensureTerminalCallback returns a structured unknown-run signal for a missing run log', async () => {
  const result = await ensureTerminalCallback({ runId: `ter_missing_${suffix()}` });
  assert.equal(result.terminal, false);
  assert.equal(result.routed, false);
  assert.equal(result.reason, 'unknown-run');
  assert.equal(typeof result.note, 'string');
});

test('ensureTerminalCallback returns unreadable-metadata for a corrupt run log instead of throwing', async () => {
  const runId = `ter_corrupt_${suffix()}`;
  const path = metadataPath(runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'this is not json{');
  const result = await ensureTerminalCallback({ runId });
  assert.equal(result.terminal, false);
  assert.equal(result.routed, false);
  assert.equal(result.reason, 'unreadable-metadata');
});

test('ensureTerminalCallback reports a live active run as non-terminal without routing', async () => {
  // Use the live test-runner pid so reconcileRun keeps the run "running" rather
  // than reclassifying a stale/dead supervisor as terminal.
  await writeRunMetadata(RUN_ID, {
    runId: RUN_ID,
    status: 'running',
    ok: true,
    pid: process.pid,
    childPid: process.pid,
    supervisorPid: process.pid,
    lastSeenAt: new Date().toISOString(),
  });
  const result = await ensureTerminalCallback({ runId: RUN_ID });
  assert.equal(result.terminal, false);
  assert.equal(result.routed, false);
  assert.equal(result.reason, 'active');
});

test('ensureTerminalCallback routes a terminal run and reports a durable event handle', async () => {
  const runId = `ter_terminal_${suffix()}`;
  await writeRunMetadata(runId, {
    runId,
    status: 'completed',
    ok: true,
    exitCode: 0,
    signal: null,
    cwd: LOG_DIR,
    originalCwd: LOG_DIR,
    finishedAt: new Date().toISOString(),
    taskFingerprint: 'deadbeef',
  });
  const result = await ensureTerminalCallback({ runId });
  assert.equal(result.terminal, true);
  assert.equal(typeof result.eventId, 'string');
  assert.equal(result.routed, true);

  // Recovering a second time is idempotent: still terminal, but flagged duplicate.
  const again = await ensureTerminalCallback({ runId });
  assert.equal(again.terminal, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.routed, false);
});
