// End-to-end proof for the minimal local Cloud Terrarium cell.
//
// Exercises the durable execution + terminal callback invariants entirely in-memory:
//   1. correlated receipt => done (success)
//   2. exit 0 + missing receipt => inconclusive (exit alone is not success)
//   3. mismatched nonce => inconclusive
//   4. duplicate collect emits exactly one terminal callback (idempotent finalize)
//   5. finish-before-subscribe => durable journal replays the terminal callback
//   6. cross-owner status read fails closed
//   7. timeout => failed/deadline-reached, partial logs, no success, one terminal callback
//   8. cancel => cancelled/cancel-requested, partial logs, one terminal callback
//   9. cancel/timeout intent wins over a raced verified receipt

import test from "node:test";
import assert from "node:assert/strict";

import {
  TerrariumRunCell,
  RunStateStore,
  LogArtifactStore,
  RunIndexStore,
  TerminalCallbackTransport,
  DetachedProcessBackend,
  taskFingerprint,
  validateReceipt,
} from "../src/cloud/local-run-cell.js";

// Durable substrate shared across (possibly restarted) cells.
function makeStores() {
  return {
    state: new RunStateStore(),
    logs: new LogArtifactStore(),
    index: new RunIndexStore(),
    callbacks: new TerminalCallbackTransport(),
    backend: new DetachedProcessBackend(),
  };
}

function makeCell() {
  return new TerrariumRunCell(makeStores());
}

test("correlated receipt on clean exit => done + verified", async () => {
  const cell = makeCell();
  const { runId, contract } = cell.launch({ task: "summarize repo", ownerId: "owner-A" });

  assert.equal(contract.runId, runId);
  assert.equal(contract.taskFingerprint, taskFingerprint("summarize repo"));

  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "done");
  assert.equal(terminal.ok, true);
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.taskContractStatus, "verified");
  assert.equal(terminal.taskResultSummary, "task-specific result");

  const st = cell.status(runId, "owner-A");
  assert.equal(st.status, "done");
});

test("exit 0 with missing receipt => inconclusive, not done", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({
    task: "do the thing",
    ownerId: "owner-A",
    spec: { exitCode: 0, emitReceipt: false },
  });

  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "inconclusive");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.exitCode, 0);
  assert.equal(terminal.taskContractStatus, "missing");
});

test("mismatched nonce => inconclusive on clean exit", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({
    task: "do the thing",
    ownerId: "owner-A",
    spec: { exitCode: 0, receiptOverride: { nonce: "not-the-real-nonce" } },
  });

  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "inconclusive");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.taskContractStatus, "mismatch");
});

test("duplicate collect finalizes once and emits exactly one terminal callback", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "idempotent", ownerId: "owner-A" });

  cell.subscribe("sub-1", { runId, ownerId: "owner-A" });

  const [a, b, c] = await Promise.all([
    cell.collect(runId),
    cell.collect(runId),
    cell.collect(runId),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  const again = await cell.collect(runId);
  assert.equal(again, a);

  const events = cell.collectCallbacks("sub-1");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, `evt_${runId}_terminal`);
  assert.equal(events[0].status, "done");
});

test("terminal callback subscriptions require ownerId", () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "owner required", ownerId: "owner-A" });
  assert.throws(() => cell.subscribe("anon", { runId }), /requires ownerId/);
});

test("finish-before-subscribe => durable journal replays the terminal callback", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "race", ownerId: "owner-A" });

  // Finalize BEFORE any subscriber exists.
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "done");

  // Subscribe afterward; journal must replay.
  cell.subscribe("late-sub", { runId, ownerId: "owner-A" });
  const events = cell.collectCallbacks("late-sub");
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, runId);
  assert.equal(events[0].type, "run.finished");
});

test("capabilityEnvelope is audit-only and copy-safe in run status", async () => {
  const cell = makeCell();
  const envelope = { allowedWrites: ["docs/**"], nested: { mode: "audit" } };
  const { runId } = cell.launch({ task: "capability envelope", ownerId: "owner-A", spec: { capabilityEnvelope: envelope } });
  envelope.allowedWrites.push("mutated/**");

  assert.deepEqual(cell.status(runId, "owner-A").capabilityEnvelope, { allowedWrites: ["docs/**"], nested: { mode: "audit" } });
  const exposed = cell.status(runId, "owner-A").capabilityEnvelope;
  exposed.nested.mode = "mutated";
  assert.equal(cell.status(runId, "owner-A").capabilityEnvelope.nested.mode, "audit");

  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "done");
  assert.equal(cell.status(runId, "owner-A").capabilityEnvelope.allowedWrites[0], "docs/**");
});

test("missing capabilityEnvelope reports null", () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "no capability envelope", ownerId: "owner-A" });
  assert.equal(cell.status(runId, "owner-A").capabilityEnvelope, null);
});

test("status is owner-scoped: cross-owner read fails closed", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "private", ownerId: "owner-A" });
  await cell.collect(runId);

  // Owner sees it.
  assert.equal(cell.status(runId, "owner-A").status, "done");

  // Different owner is denied.
  assert.throws(() => cell.status(runId, "owner-B"), (err) => err.code === "EACCES");

  // Unknown run is ENOENT.
  assert.throws(() => cell.status("ter_missing", "owner-A"), (err) => err.code === "ENOENT");
});

const RESULT_MARKER = "TERRARIUM_RESULT=";

test("timeout => failed/deadline-reached with partial logs, no success, one terminal callback", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({
    task: "long job",
    ownerId: "owner-A",
    spec: { blocks: true, partialStdout: "step 1 of 3\n" },
  });

  cell.subscribe("sub-t", { runId, ownerId: "owner-A" });

  // Deadline fires, then the cell collects the terminated child.
  cell.timeout(runId);
  const terminal = await cell.collect(runId);

  assert.equal(terminal.status, "failed");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.reason, "deadline-reached");
  assert.equal(terminal.taskContractStatus, "not-applicable");
  assert.equal(terminal.exitCode, 124);
  assert.equal(terminal.signal, "SIGKILL");
  assert.equal(terminal.taskResultSummary, undefined);

  // Partial logs are retained but carry no success receipt.
  const logs = cell.logs(runId);
  assert.equal(logs, "step 1 of 3\n");
  assert.ok(!logs.includes(RESULT_MARKER));

  // Exactly one terminal callback after commit.
  const events = cell.collectCallbacks("sub-t");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, `evt_${runId}_terminal`);
  assert.equal(events[0].status, "failed");
  assert.equal(events[0].ok, false);

  assert.equal(cell.status(runId, "owner-A").status, "failed");
});

test("cancel => cancelled/cancel-requested with partial logs, one terminal callback", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({
    task: "cancellable job",
    ownerId: "owner-A",
    spec: { blocks: true, partialStdout: "working...\n" },
  });

  cell.subscribe("sub-c", { runId, ownerId: "owner-A" });

  cell.cancel(runId);
  const terminal = await cell.collect(runId);

  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.reason, "cancel-requested");
  assert.equal(terminal.taskContractStatus, "not-applicable");
  assert.equal(terminal.exitCode, 143);
  assert.equal(terminal.signal, "SIGTERM");
  assert.equal(terminal.taskResultSummary, undefined);

  const logs = cell.logs(runId);
  assert.equal(logs, "working...\n");
  assert.ok(!logs.includes(RESULT_MARKER));

  const events = cell.collectCallbacks("sub-c");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, `evt_${runId}_terminal`);
  assert.equal(events[0].status, "cancelled");

  assert.equal(cell.status(runId, "owner-A").status, "cancelled");
});

test("duplicate collect after cancel emits exactly one terminal callback (idempotent)", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({
    task: "double-collect cancel",
    ownerId: "owner-A",
    spec: { blocks: true },
  });
  cell.subscribe("sub-cc", { runId, ownerId: "owner-A" });

  cell.cancel(runId);
  const [a, b] = await Promise.all([cell.collect(runId), cell.collect(runId)]);
  const again = await cell.collect(runId);
  assert.equal(a, b);
  assert.equal(again, a);
  assert.equal(a.status, "cancelled");

  const events = cell.collectCallbacks("sub-cc");
  assert.equal(events.length, 1);
});

test("cancel intent wins over a raced verified receipt (semantics preserved)", async () => {
  const cell = makeCell();
  const { runId, contract } = cell.launch({
    task: "raced cancel",
    ownerId: "owner-A",
    // Child DID emit a full verified receipt, yet was cancelled anyway.
    spec: { blocks: true, receiptDespiteKill: true, partialStdout: "almost done\n" },
  });

  cell.cancel(runId);
  const terminal = await cell.collect(runId);

  // Cancel intent wins: never accepted as success despite the verified marker.
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.taskContractStatus, "not-applicable");
  assert.equal(terminal.taskResultSummary, undefined);

  // The raced receipt is genuinely verifiable against the contract and stays
  // on disk for auditability, yet cancel intent still wins over it.
  const logs = cell.logs(runId);
  assert.ok(logs.includes(RESULT_MARKER));
  assert.equal(validateReceipt(logs, contract).status, "verified");
});

test("timeout intent wins over a raced verified receipt", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({
    task: "raced timeout",
    ownerId: "owner-A",
    spec: { blocks: true, receiptDespiteKill: true },
  });

  cell.timeout(runId);
  const terminal = await cell.collect(runId);

  assert.equal(terminal.status, "failed");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.reason, "deadline-reached");
  assert.equal(terminal.taskContractStatus, "not-applicable");
  assert.equal(terminal.taskResultSummary, undefined);
});

test("validateReceipt classifies malformed and extra-key receipts", () => {
  const expected = { runId: "r1", taskFingerprint: "fp1", nonce: "n1" };
  assert.equal(validateReceipt("no marker here", expected).status, "missing");
  assert.equal(
    validateReceipt(`TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary: "ok", extra: 1 })}`, expected).status,
    "malformed",
  );
  assert.equal(validateReceipt("TERRARIUM_RESULT={not json", expected).status, "malformed");
  assert.equal(
    validateReceipt(`TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary: "ok" })}`, expected).status,
    "verified",
  );
});

// ---------------------------------------------------------------------------
// Red-team P0: detached backend shape. The RunCell must NOT depend on a held
// live handle. A cell that crashed and lost every in-memory handle must still
// cancel, apply deadlines, finalize, and repair missed terminal callbacks purely from the
// persisted executionRef + intent + durable stores.
// ---------------------------------------------------------------------------

test("collect finalizes via persisted executionRef after handle loss", async () => {
  const stores = makeStores();

  // Original cell launches, then is lost (crash/restart) BEFORE collecting.
  const launcher = new TerrariumRunCell(stores);
  const { runId, contract } = launcher.launch({ task: "handle loss", ownerId: "owner-A" });

  // Brand-new cell instance: empty handle map, sharing only the durable
  // stores + detached backend. It never saw the live handle.
  const restarted = new TerrariumRunCell(stores);
  const terminal = await restarted.collect(runId);

  assert.equal(terminal.status, "done");
  assert.equal(terminal.ok, true);
  assert.equal(terminal.taskContractStatus, "verified");

  // Receipt was validated from the persisted log store, not live stdout.
  assert.equal(validateReceipt(stores.logs.read(runId), contract).status, "verified");
  assert.equal(restarted.status(runId, "owner-A").status, "done");
});

test("cancel intent survives handle loss and wins finalization", async () => {
  const stores = makeStores();
  const launcher = new TerrariumRunCell(stores);
  // Child would emit a full verified receipt if left alone.
  const { runId } = launcher.launch({
    task: "cancel after crash",
    ownerId: "owner-A",
    spec: { blocks: true, receiptDespiteKill: true, partialStdout: "half\n" },
  });

  // Cell is lost; a fresh cell (no handles) issues the cancel by ref.
  const restarted = new TerrariumRunCell(stores);
  restarted.cancel(runId); // must not be a silent no-op despite handle loss
  assert.equal(stores.state.get(runId).intent, "cancel"); // intent persisted durably

  const terminal = await restarted.collect(runId);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.reason, "cancel-requested");
  assert.equal(terminal.taskContractStatus, "not-applicable");
  assert.equal(terminal.taskResultSummary, undefined);
});

test("deadline intent survives handle loss and wins finalization", async () => {
  const stores = makeStores();
  const launcher = new TerrariumRunCell(stores);
  const { runId } = launcher.launch({
    task: "deadline after crash",
    ownerId: "owner-A",
    spec: { blocks: true, receiptDespiteKill: true },
  });

  const restarted = new TerrariumRunCell(stores);
  restarted.timeout(runId); // deadline applied by ref after handle loss
  assert.equal(stores.state.get(runId).intent, "timeout"); // intent persisted durably

  const terminal = await restarted.collect(runId);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.reason, "deadline-reached");
  assert.equal(terminal.taskContractStatus, "not-applicable");
  assert.equal(terminal.taskResultSummary, undefined);
});

test("reconcile emits exactly one terminal callback after commit-before-callback crash", async () => {
  const stores = makeStores();

  // Terminal callback transport that throws on its FIRST queue() to model a crash after the
  // terminal state is committed but before the callback is durably emitted.
  const realQueue = stores.callbacks.queue.bind(stores.callbacks);
  let crashed = false;
  stores.callbacks.queue = (event) => {
    if (!crashed) {
      crashed = true;
      throw new Error("crash before callback emit");
    }
    return realQueue(event);
  };

  const cell = new TerrariumRunCell(stores);
  const { runId } = cell.launch({ task: "commit then crash", ownerId: "owner-A" });

  // Collect commits terminal state, then the crash prevents the callback.
  await assert.rejects(() => cell.collect(runId), /crash before callback emit/);
  assert.equal(stores.state.get(runId).finalized, true);
  assert.equal(stores.state.get(runId).status, "done");

  // A subscriber attaches; the journal is still empty (no callback ever landed).
  cell.subscribe("sub-recon", { runId, ownerId: "owner-A" });
  assert.equal(cell.collectCallbacks("sub-recon").length, 0);

  // Reconcile repairs the missing callback — exactly one.
  const first = cell.reconcile(runId);
  assert.equal(first.repaired, true);
  const events = cell.collectCallbacks("sub-recon");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, `evt_${runId}_terminal`);
  assert.equal(events[0].status, "done");

  // Reconciling again is idempotent: journal dedup => no second delivery.
  const second = cell.reconcile(runId);
  assert.equal(second.repaired, false);
  assert.equal(second.deduped, true);
  assert.equal(cell.collectCallbacks("sub-recon").length, 0);
});

test("receipt validates across multiple persisted log chunks", async () => {
  const stores = makeStores();
  const cell = new TerrariumRunCell(stores);
  const { runId, contract } = cell.launch({
    task: "chunked receipt",
    ownerId: "owner-A",
    spec: { chunked: true }, // receipt line is split across chunk boundaries
  });

  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "done");
  assert.equal(terminal.taskContractStatus, "verified");

  // The store holds >1 chunk, and no single chunk contains the whole marker
  // line — yet the rejoined persisted store validates as verified.
  const chunks = stores.backend.logChunks(stores.state.get(runId).executionRef);
  assert.ok(chunks.length >= 3);
  assert.ok(!chunks.some((c) => c.includes(RESULT_MARKER) && c.includes("\n")));
  assert.equal(validateReceipt(stores.logs.read(runId), contract).status, "verified");
});
