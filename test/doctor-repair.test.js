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
  // requeue runs as the top-level controller (ownerRunId null), so the
  // subscriber it repairs must be controller-owned to match.
  await registerSubscriber({ subscriberId, ownerRunId: null });
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
    await unregisterSubscriber(subscriberId, { ownerRunId: null }).catch(() => {});
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
    if (IS_CHILD) {
      // pruneStaleChildClaims is a top-level-only affordance; inside a child each
      // dispatched step must fail closed (skipped) and the claims must remain.
      assert.equal(result.ok, false);
      assert.ok(result.skipped.filter((entry) => entry.kind === 'staleChildClaim' && /top-level controller/.test(entry.reason)).length >= 1);
      assert.ok((await readdir(claimsDir)).length >= 2);
    } else {
      assert.equal(result.ok, true);
      // Exactly one step dispatches the prune; the second is folded into it so
      // the global pruneStaleChildClaims pass runs at most once.
      const ran = result.applied.filter((entry) => entry.kind === 'staleChildClaim' && entry.coveredByPriorPrune !== true);
      assert.equal(ran.length, 1);
      assert.ok(ran[0].prunedCount >= 2);
      const covered = result.applied.filter((entry) => entry.coveredByPriorPrune === true);
      assert.equal(covered.length, 1, 'second stale-claim step must be covered by the first prune');
      // The stale claim directory should be reclaimed.
      let exists = true;
      try { await readdir(claimsDir); } catch { exists = false; }
      assert.equal(exists, false);
    }
  } finally {
    await rm(claimsDir, { recursive: true, force: true });
  }
});

test('executeRepairPlan with verify attaches residual evidence that the cleared condition reconciled', async () => {
  if (IS_CHILD) return; // requeue is a top-level-only affordance
  const suffix = `${process.pid}_${Date.now()}_verify`;
  const subscriberId = `repair_verify_${suffix}`;
  const inflightDir = `${MAILBOXES_DIR}/${subscriberId}/inflight`;
  const inflightId = `evt_stale_${suffix}`;
  await registerSubscriber({ subscriberId, ownerRunId: null });
  await mkdir(inflightDir, { recursive: true });
  await writeFile(`${inflightDir}/${inflightId}.json`, JSON.stringify({ eventId: inflightId, type: 'Completed', runId: `ter_${suffix}`, at: '2020-01-01T00:00:00.000Z', claimedAt: '2020-01-01T00:00:00.000Z' }));
  try {
    const plan = [{ kind: 'staleInflightCallback', subscriberId, action: 'requeue', tool: 'terrarium_callbacks', args: { action: 'requeue', subscriberId } }];
    const result = await executeRepairPlan({ plan, dryRun: false, verify: true });
    assert.equal(result.ok, true);
    assert.ok(result.residual, 'apply+verify must attach a residual evidence block');
    const condition = result.residual.conditions.find((entry) => entry.kind === 'staleInflightCallback');
    assert.ok(condition, 'residual must include the repaired condition');
    assert.equal(condition.counter, 'staleInflightCallbacks');
    assert.equal(condition.after, 0, 're-diagnosis must show the stale-inflight counter cleared');
    assert.equal(condition.cleared, true);
    assert.equal(condition.before, null, 'no baseline supplied -> before is recorded as null');
    // No other stale inflight callbacks should leak into this freshly-created
    // subscriber, so the whole verification should pass.
    assert.equal(result.residual.verified, true);
  } finally {
    await unregisterSubscriber(subscriberId, { ownerRunId: null }).catch(() => {});
    await rm(`${MAILBOXES_DIR}/${subscriberId}`, { recursive: true, force: true });
  }
});

test('executeRepairPlan verify records the pre-repair count when a baseline is supplied', async () => {
  const baseline = { checks: { staleInflightCallbacks: 3 }, repairPlan: [] };
  const plan = [{ kind: 'staleInflightCallback', action: 'requeue' }]; // no subscriberId -> skipped, no mutation
  const result = await executeRepairPlan({ plan, dryRun: false, verify: true, baseline });
  const condition = result.residual.conditions.find((entry) => entry.kind === 'staleInflightCallback');
  assert.equal(condition.before, 3, 'before must come from the supplied baseline diagnosis');
});

test('executeRepairPlan never verifies a dry run (nothing changed to re-measure)', async () => {
  const plan = [{ kind: 'staleInflightCallback', subscriberId: `sub_${Date.now()}`, action: 'requeue' }];
  const result = await executeRepairPlan({ plan, verify: true }); // dryRun defaults true
  assert.equal(result.dryRun, true);
  assert.equal(result.residual, undefined, 'a dry run must not attach residual evidence');
});

test('executeRepairPlan refuses to run for a child requester', async () => {
  await assert.rejects(() => executeRepairPlan({ plan: [], requesterRunId: 'ter_child' }), /top-level controller/);
});

test('executeRepairPlan records no-op repair attempts and keeps malformed steps skipped', async () => {
  // Requeue for a nonexistent subscriber is an idempotent no-op in the router
  // primitive (0 requeued), while an unattributed step is still skipped.
  const plan = [
    { kind: 'staleInflightCallback', subscriberId: `nonexistent_${Date.now()}`, action: 'requeue' },
    { kind: 'staleInflightCallback', action: 'requeue' }, // no subscriberId -> skipped
  ];
  const result = await executeRepairPlan({ plan, dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(result.appliedCount, 1);
  assert.equal(result.applied[0].requeued, 0);
  assert.equal(result.skippedCount, 1);
  assert.ok(result.skipped.some((entry) => /could not be attributed/.test(entry.reason)));
});
