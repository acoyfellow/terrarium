// Local proof for the Cloud Terrarium admission gate + backend adapter port.
//
// Proves the two pieces the run-cell spike adds on top of local-run-cell.js:
//
//   A. POST/admit gate (src/cloud/admission.js)
//      1. admit accepts a valid request => 202 + correlated contract + a running run
//      2. missing owner / missing task / oversized task / disallowed owner /
//         concurrency-exceeded all reject with stable 4xx reasons and start NO run
//      3. handleAdmit returns an HTTP-shaped { status, body }
//      4. an admitted run drives the full cell lifecycle to a verified receipt
//
//   B. Backend adapter port (src/cloud/backend-adapter.js)
//      5. assertBackendAdapter fails closed on a non-conforming object
//      6. SandboxContainerBackend conforms to the port and is drop-in for the
//         cell: same done/verified terminal + terminal callback as the detached backend
//      7. container metadata (sandboxId/image) is exposed without changing the
//         port the cell depends on
//      8. cancel/timeout by ref still work through the container adapter

import test from "node:test";
import assert from "node:assert/strict";

import {
  TerrariumRunCell,
  RunStateStore,
  LogArtifactStore,
  RunIndexStore,
  TerminalCallbackTransport,
  DetachedProcessBackend,
} from "../src/cloud/local-run-cell.js";
import {
  AdmissionController,
  evaluateAdmission,
  handleAdmit,
  DEFAULT_ADMISSION_POLICY,
  normalizeCapabilityEnvelope,
} from "../src/cloud/admission.js";
import {
  SandboxContainerBackend,
  assertBackendAdapter,
  BACKEND_ADAPTER_METHODS,
} from "../src/cloud/backend-adapter.js";

function makeCell(backend = new DetachedProcessBackend()) {
  return new TerrariumRunCell({
    state: new RunStateStore(),
    logs: new LogArtifactStore(),
    index: new RunIndexStore(),
    callbacks: new TerminalCallbackTransport(),
    backend,
  });
}

// ---------------------------------------------------------------------------
// A. POST/admit gate
// ---------------------------------------------------------------------------

test("admit accepts a valid request => 202 + correlated contract + running run", () => {
  const cell = makeCell();
  const ctrl = new AdmissionController({ cell });

  const res = ctrl.admit({ task: "summarize repo", ownerId: "owner-A" });
  assert.equal(res.admitted, true);
  assert.equal(res.status, 202);
  assert.equal(res.contract.runId, res.runId);
  assert.ok(res.executionRef);

  // The admitted run is real and owner-scoped and running.
  assert.equal(cell.status(res.runId, "owner-A").status, "running");
  assert.deepEqual(cell.list("owner-A"), [res.runId]);
});

test("admit rejects missing owner / task with stable 4xx and starts NO run", () => {
  const cell = makeCell();
  const ctrl = new AdmissionController({ cell });

  const noOwner = ctrl.admit({ task: "x" });
  assert.deepEqual(
    { admitted: noOwner.admitted, status: noOwner.status, reason: noOwner.reason },
    { admitted: false, status: 401, reason: "missing-owner" },
  );

  const noTask = ctrl.admit({ ownerId: "owner-A" });
  assert.deepEqual(
    { admitted: noTask.admitted, status: noTask.status, reason: noTask.reason },
    { admitted: false, status: 400, reason: "missing-task" },
  );

  // Nothing was launched.
  assert.deepEqual(cell.list("owner-A"), []);
});

test("admit rejects oversized task and disallowed owner", () => {
  const cell = makeCell();
  const ctrl = new AdmissionController({
    cell,
    policy: { maxTaskBytes: 16, allowOwners: ["owner-A"] },
  });

  const tooBig = ctrl.admit({ task: "x".repeat(64), ownerId: "owner-A" });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.reason, "task-too-large");

  const notAllowed = ctrl.admit({ task: "ok", ownerId: "owner-Z" });
  assert.equal(notAllowed.status, 403);
  assert.equal(notAllowed.reason, "owner-not-allowed");

  assert.deepEqual(cell.list("owner-A"), []);
});

test("admit enforces per-owner concurrency budget", () => {
  const cell = makeCell();
  const ctrl = new AdmissionController({ cell, policy: { maxConcurrentPerOwner: 2 } });

  assert.equal(ctrl.admit({ task: "a", ownerId: "owner-A" }).status, 202);
  assert.equal(ctrl.admit({ task: "b", ownerId: "owner-A" }).status, 202);

  const third = ctrl.admit({ task: "c", ownerId: "owner-A" });
  assert.equal(third.admitted, false);
  assert.equal(third.status, 429);
  assert.equal(third.reason, "owner-concurrency-exceeded");

  // A different owner is unaffected by A's budget.
  assert.equal(ctrl.admit({ task: "d", ownerId: "owner-B" }).status, 202);
});

test("concurrency budget frees up after a run reaches terminal", async () => {
  const cell = makeCell();
  const ctrl = new AdmissionController({ cell, policy: { maxConcurrentPerOwner: 1 } });

  const first = ctrl.admit({ task: "a", ownerId: "owner-A" });
  assert.equal(first.status, 202);
  // Budget full while running.
  assert.equal(ctrl.admit({ task: "b", ownerId: "owner-A" }).status, 429);

  // Finalize the first run; budget frees.
  await cell.collect(first.runId);
  assert.equal(ctrl.admit({ task: "b", ownerId: "owner-A" }).status, 202);
});

test("normalizeCapabilityEnvelope deep-copies plain objects and rejects non-objects", () => {
  const envelope = { allowedReads: ["README.md"], nested: { commands: [["npm", "test"]] } };
  const normalized = normalizeCapabilityEnvelope(envelope);
  assert.deepEqual(normalized, envelope);
  assert.notEqual(normalized, envelope);
  assert.notEqual(normalized.nested, envelope.nested);
  envelope.nested.commands[0].push("mutated");
  assert.deepEqual(normalized.nested.commands, [["npm", "test"]]);
  assert.equal(normalizeCapabilityEnvelope(null), undefined);
  assert.equal(normalizeCapabilityEnvelope(["README.md"]), undefined);
  assert.equal(normalizeCapabilityEnvelope("bad"), undefined);
});

test("admit stores a copy-safe audit-only capabilityEnvelope", async () => {
  const cell = makeCell();
  const ctrl = new AdmissionController({ cell });
  const capabilityEnvelope = { allowedReads: ["README.md"], allowedCommands: [["npm", "test"]] };
  const res = ctrl.admit({ task: "audit only", ownerId: "owner-A", capabilityEnvelope });
  capabilityEnvelope.allowedReads.push("mutated.md");

  assert.equal(res.status, 202);
  const running = cell.status(res.runId, "owner-A");
  assert.deepEqual(running.capabilityEnvelope, { allowedReads: ["README.md"], allowedCommands: [["npm", "test"]] });
  running.capabilityEnvelope.allowedReads.push("caller-mutated.md");
  assert.deepEqual(cell.status(res.runId, "owner-A").capabilityEnvelope.allowedReads, ["README.md"]);

  const terminal = await cell.collect(res.runId);
  assert.equal(terminal.status, "done");
  assert.equal(cell.status(res.runId, "owner-A").capabilityEnvelope.allowedReads[0], "README.md");
});

test("admit ignores malformed capabilityEnvelope and remains additive", () => {
  const cell = makeCell();
  const ctrl = new AdmissionController({ cell });
  const absent = ctrl.admit({ task: "no envelope", ownerId: "owner-A" });
  const malformed = ctrl.admit({ task: "bad envelope", ownerId: "owner-A", capabilityEnvelope: ["not", "plain"] });
  assert.equal(absent.status, 202);
  assert.equal(malformed.status, 202);
  assert.equal(cell.status(absent.runId, "owner-A").capabilityEnvelope, null);
  assert.equal(cell.status(malformed.runId, "owner-A").capabilityEnvelope, null);
});

test("handleAdmit returns HTTP-shaped { status, body }", () => {
  const cell = makeCell();
  const ctrl = new AdmissionController({ cell });

  const ok = handleAdmit(ctrl, { task: "t", ownerId: "owner-A" });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.admitted, true);

  const bad = handleAdmit(ctrl, null);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.admitted, false);
  assert.equal(bad.body.reason, "invalid-body");
});

test("admitted run drives the cell lifecycle to a verified receipt", async () => {
  const cell = makeCell();
  const ctrl = new AdmissionController({ cell });

  const res = ctrl.admit({ task: "end to end", ownerId: "owner-A" });
  cell.subscribe("sub", { runId: res.runId, ownerId: "owner-A" });

  const terminal = await cell.collect(res.runId);
  assert.equal(terminal.status, "done");
  assert.equal(terminal.ok, true);
  assert.equal(terminal.taskContractStatus, "verified");

  const events = cell.collectCallbacks("sub");
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "done");
});

test("evaluateAdmission is a pure policy function usable without a cell", () => {
  const ok = evaluateAdmission({ task: "t", ownerId: "o" }, DEFAULT_ADMISSION_POLICY, 0);
  assert.equal(ok.ok, true);
  const busy = evaluateAdmission({ task: "t", ownerId: "o" }, DEFAULT_ADMISSION_POLICY, 999);
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, "owner-concurrency-exceeded");
});

// ---------------------------------------------------------------------------
// B. Backend adapter port
// ---------------------------------------------------------------------------

test("assertBackendAdapter fails closed on non-conforming objects", () => {
  assert.throws(() => assertBackendAdapter(null), TypeError);
  assert.throws(() => assertBackendAdapter({ start() {} }), /missing backend adapter methods/);
  // A full detached backend passes.
  assert.equal(assertBackendAdapter(new DetachedProcessBackend()) instanceof DetachedProcessBackend, true);
  // Port surface is exactly the five methods.
  assert.deepEqual(BACKEND_ADAPTER_METHODS, ["start", "waitExit", "logChunks", "cancel", "timeout"]);
});

test("SandboxContainerBackend conforms to the port", () => {
  assert.doesNotThrow(() => assertBackendAdapter(new SandboxContainerBackend()));
});

test("SandboxContainerBackend is drop-in for the cell: same done/verified terminal", async () => {
  const backend = new SandboxContainerBackend({ image: "terrarium/sandbox:spike" });
  const cell = makeCell(backend);
  const ctrl = new AdmissionController({ cell });

  const res = ctrl.admit({ task: "run in a container", ownerId: "owner-A" });
  assert.equal(res.admitted, true);

  cell.subscribe("sub-c", { runId: res.runId, ownerId: "owner-A" });
  const terminal = await cell.collect(res.runId);

  // Identical control-plane outcome to the detached backend.
  assert.equal(terminal.status, "done");
  assert.equal(terminal.ok, true);
  assert.equal(terminal.taskContractStatus, "verified");
  assert.equal(terminal.taskResultSummary, "task-specific result");

  const events = cell.collectCallbacks("sub-c");
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "done");

  // Container metadata is exposed via the non-port describe() helper only.
  const meta = backend.describe(res.executionRef);
  assert.equal(meta.image, "terrarium/sandbox:spike");
  assert.ok(meta.sandboxId.startsWith("sbx_"));
  assert.ok(meta.sandboxId.includes(res.runId));
});

test("SandboxContainerBackend honors cancel by ref through the cell", async () => {
  const backend = new SandboxContainerBackend();
  const cell = makeCell(backend);
  const { runId } = cell.launch({
    task: "cancellable container run",
    ownerId: "owner-A",
    spec: { blocks: true, partialStdout: "booting sandbox...\n" },
  });

  cell.cancel(runId);
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.reason, "cancel-requested");
  assert.equal(terminal.exitCode, 143);
  assert.ok(!cell.logs(runId).includes("TERRARIUM_RESULT="));
});

test("SandboxContainerBackend honors timeout by ref through the cell", async () => {
  const backend = new SandboxContainerBackend();
  const cell = makeCell(backend);
  const { runId } = cell.launch({
    task: "slow container run",
    ownerId: "owner-A",
    spec: { blocks: true },
  });

  cell.timeout(runId);
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.reason, "deadline-reached");
  assert.equal(terminal.exitCode, 124);
});

test("container adapter survives handle loss: finalize from persisted ref", async () => {
  const backend = new SandboxContainerBackend();
  const stores = {
    state: new RunStateStore(),
    logs: new LogArtifactStore(),
    index: new RunIndexStore(),
    callbacks: new TerminalCallbackTransport(),
    backend,
  };
  const launcher = new TerrariumRunCell(stores);
  const { runId } = launcher.launch({ task: "container handle loss", ownerId: "owner-A" });

  // Fresh cell, no in-memory handles, same durable stores + container backend.
  const restarted = new TerrariumRunCell(stores);
  const terminal = await restarted.collect(runId);
  assert.equal(terminal.status, "done");
  assert.equal(terminal.taskContractStatus, "verified");
});
