import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { executeRepairPlan } from '../src/doctor.js';
import { LOG_DIR } from '../src/core.js';
import { MAILBOXES_DIR, registerSubscriber, unregisterSubscriber } from '../src/router.js';

// pruneStaleChildClaims and the controller-only guards refuse to run while a
// TERRARIUM_RUN_ID is set (i.e. inside a child agent). Detect that so the
// child-claim test asserts the correct top-level-only behaviour either way.
const IS_CHILD = !!process.env.TERRARIUM_RUN_ID;

test('executeRepairPlan defaults to dry-run and never mutates state', async () => {
  const suffix = `${process.pid}_${Date.now()}_dryrun`;
  const subscriberId = `repair_dryrun_${suffix}`;
  const inflightDir = `${MAILBOXES_DIR}/${subscriberId}/inflight`;
  const inflightId = `evt_stale_${suffix}`;
  await mkdir(inflightDir, { recursive: true });
  await writeFile(`${inflightDir}/${inflightId}.json`, JSON.stringify({ eventId: inflightId, type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '2020-01-01T00:00:00.000Z' }));
  try {
    const plan = [{ kind: 'staleInflightCallback', subscriberId, action: 'requeue', tool: 'terrarium_callbacks', args: { action: 'requeue', subscriberId } }];
    const result = await executeRepairPlan({ plan });
    assert.equal(result.dryRun, true);
    assert.equal(result.ok, true);
    assert.equal(result.appliedCount, 1);
    const step = result.applied.find((entry) => entry.kind === 'staleInflightCallback');
    assert.equal(step.dryRun, true);
    assert.equal(step.action, 'requeue');
    assert.equal(step.subscriberId, subscriberId);
    // Dry run must not move the inflight event out of the inflight mailbox.
    const inflight = await readdir(inflightDir);
    assert.ok(inflight.includes(`${inflightId}.json`));
  } finally {
    await rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true });
  }
});

test('executeRepairPlan with apply requeues stale inflight callbacks via the router primitive', async () => {
  const suffix = `${process.pid}_${Date.now()}_apply`;
  const subscriberId = `repair_apply_${suffix}`;
  const inflightDir = `${MAILBOXES_DIR}/${subscriberId}/inflight`;
  const pendingDir = `${MAILBOXES_DIR}/${subscriberId}/pending`;
  const inflightId = `evt_stale_${suffix}`;
  // requeue operates through the router primitive, which requires a registered
  // subscriber the caller owns. Register it (ownerRunId mirrors the caller).
  await registerSubscriber({ subscriberId, ownerRunId: process.env.TERRARIUM_RUN_ID || null });
  await mkdir(inflightDir, { recursive: true });
  await writeFile(`${inflightDir}/${inflightId}.json`, JSON.stringify({ eventId: inflightId, type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '2020-01-01T00:00:00.000Z' }));
  try {
    const plan = [{ kind: 'staleInflightCallback', subscriberId, action: 'requeue', tool: 'terrarium_callbacks', args: { action: 'requeue', subscriberId } }];
    const result = await executeRepairPlan({ plan, dryRun: false });
    assert.equal(result.dryRun, false);
    assert.equal(result.ok, true);
    const step = result.applied.find((entry) => entry.kind === 'staleInflightCallback');
    assert.equal(step.dryRun, false);
    assert.equal(step.requeued, 1);
    // The event must have moved from inflight to pending.
    assert.deepEqual(await readdir(inflightDir), []);
    assert.ok((await readdir(pendingDir)).includes(`${inflightId}.json`));
  } finally {
    await unregisterSubscriber(subscriberId, { ownerRunId: process.env.TERRARIUM_RUN_ID || null }).catch(() => {});
    await rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true });
  }
});

test('executeRepairPlan skips judgement and quarantine steps without executing them', async () => {
  const plan = [
    { kind: 'orphanedRun', runId: 'ter_orphan', action: 'inspect', tool: 'terrarium_read', args: { runId: 'ter_orphan' } },
    { kind: 'needsAttentionRun', runId: 'ter_attn', action: 'inspect', tool: 'terrarium_read', args: { runId: 'ter_attn' } },
    { kind: 'malformedRouterRecords', count: 2, action: 'quarantine' },
  ];
  const result = await executeRepairPlan({ plan, dryRun: false });
  assert.equal(result.appliedCount, 0);
  assert.equal(result.skippedCount, 3);
  assert.equal(result.ok, false);
  const kinds = result.skipped.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ['malformedRouterRecords', 'needsAttentionRun', 'orphanedRun']);
  for (const entry of result.skipped) assert.equal(typeof entry.reason, 'string');
});

test('executeRepairPlan collapses multiple stale child-claim steps into a single prune pass', async () => {
  const suffix = `${process.pid}_${Date.now()}_claims`;
  const claimsDir = `${LOG_DIR}/repair-${suffix}.children`;
  await mkdir(claimsDir, { recursive: true });
  await Promise.all([
    writeFile(`${claimsDir}/slot0`, `ter_missing_a_${suffix}`),
    writeFile(`${claimsDir}/slot1`, `ter_missing_b_${suffix}`),
  ]);
  try {
    const plan = [
      { kind: 'staleChildClaim', claimFile: `${claimsDir}/slot0`, childRunId: `ter_missing_a_${suffix}`, action: 'prune', tool: 'terrarium_callbacks', args: { action: 'prune' } },
      { kind: 'staleChildClaim', claimFile: `${claimsDir}/slot1`, childRunId: `ter_missing_b_${suffix}`, action: 'prune', tool: 'terrarium_callbacks', args: { action: 'prune' } },
    ];
    const result = await executeRepairPlan({ plan, dryRun: false });
    // Exactly one step dispatches the prune; the second is folded into it so the
    // global pruneStaleChildClaims pass runs at most once.
    const covered = result.applied.filter((entry) => entry.coveredByPriorPrune === true);
    assert.equal(covered.length, 1, 'second stale-claim step must be covered by the first prune');
    if (IS_CHILD) {
      // pruneStaleChildClaims is a top-level-only affordance; inside a child the
      // dispatched step must fail closed (skipped), and the claims must remain.
      assert.equal(result.ok, false);
      assert.ok(result.skipped.some((entry) => entry.kind === 'staleChildClaim' && /top-level controller/.test(entry.reason)));
      assert.ok((await readdir(claimsDir)).length >= 2);
    } else {
      assert.equal(result.ok, true);
      const ran = result.applied.filter((entry) => entry.kind === 'staleChildClaim' && entry.coveredByPriorPrune !== true);
      assert.equal(ran.length, 1);
      assert.ok(ran[0].prunedCount >= 2);
      // The stale claim directory should be reclaimed.
      let exists = true;
      try { await readdir(claimsDir); } catch { exists = false; }
      assert.equal(exists, false);
    }
  } finally {
    await rm(claimsDir, { recursive: true, force: true });
  }
});

test('executeRepairPlan refuses to run for a child requester', async () => {
  await assert.rejects(() => executeRepairPlan({ plan: [], requesterRunId: 'ter_child' }), /top-level controller/);
});

test('executeRepairPlan attributes a per-step failure without aborting the whole plan', async () => {
  // A stale-inflight step whose subscriber does not exist: requeue will throw,
  // which must be captured as a skipped step, not crash the executor.
  const plan = [
    { kind: 'staleInflightCallback', subscriberId: `nonexistent_${Date.now()}`, action: 'requeue' },
    { kind: 'staleInflightCallback', action: 'requeue' }, // no subscriberId -> skipped
  ];
  const result = await executeRepairPlan({ plan, dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(result.appliedCount, 0);
  assert.equal(result.skippedCount, 2);
  assert.ok(result.skipped.some((entry) => /could not be attributed/.test(entry.reason)));
});
