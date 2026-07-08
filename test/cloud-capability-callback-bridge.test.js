// Capability receipt <-> terminal callback bridge proof.
//
// This file proves the *integration contract* between two independently-tested
// layers when a run is executed on a Cloudbox-like remote backend:
//
//   - scripts/drift-lab/cloudbox-adapter.mjs  -> a capability *drift* receipt
//     ("terrarium-drift-lab-receipt-v0") derived from a Cloudbox ContainerRunResult
//     ({ ok, receipts, diff, artifact }) scored against a trusted envelope.
//   - src/cloud/local-run-cell.js             -> the durable execution + terminal
//     callback layer whose ONLY success authority is a verified TERRARIUM_RESULT.
//
// The four invariants under test (the whole point of the bridge):
//
//   1. Verified TERRARIUM_RESULT is the SOLE success authority. The Cloudbox
//      capability receipt never manufactures, upgrades, or downgrades task
//      success — not even a perfectly clean one (driftScore 1, taskCompleted).
//   2. Cloudbox ok:true ALONE is inconclusive. A remote run that reports ok:true
//      (and even a spotless drift receipt) but whose child never emitted a
//      correlated receipt is inconclusive, never done.
//   3. The capability drift receipt is ADVISORY (v0). It rides alongside the
//      terminal as evidence; it does not rewrite the task-contract terminal.
//   4. The terminal callback is emitted EXACTLY ONCE and is OWNER-SCOPED.
//      Duplicate collect + reconcile still yields one event; a cross-owner
//      subscriber sees nothing.
//
// Everything is in-memory: no processes, no network, no Cloudflare calls.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  TerrariumRunCell,
  RunStateStore,
  LogArtifactStore,
  RunIndexStore,
  TerminalCallbackTransport,
  DetachedProcessBackend,
} from "../src/cloud/local-run-cell.js";
import { cloudboxRunToReceipt } from "../scripts/drift-lab/cloudbox-adapter.mjs";

const ROOT = "/workspace";
const RESULT_MARKER = "TERRARIUM_RESULT=";

async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/cloudbox-adapter/${name}`, import.meta.url), "utf8"));
}

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

class FakeCloudboxBackend extends DetachedProcessBackend {
  constructor(result) {
    super();
    this.result = result;
  }

  start(spec = {}) {
    // Build the cloudbox-style stdout from the REAL server-minted contract
    // (spec.contract), so the correlated receipt always matches this run's
    // nonce even though the nonce is no longer client-supplied.
    const contract = spec.contract || {};
    const built = this.buildResult ? this.buildResult(contract) : this.result;
    const stdout = built.receipts.map((receipt) => receipt.stdout || "").join("\n");
    const verify = built.receipts.find((receipt) => receipt.type === "verify");
    return super.start({
      ...spec,
      exitCode: verify?.code ?? (built.ok ? 0 : 1),
      rawStdout: stdout,
    });
  }
}

function withTerrariumResult(result, contract, summary = "cloudbox verified task") {
  return {
    ...result,
    receipts: [
      ...result.receipts,
      {
        type: "verify",
        cmd: "emit terrarium result",
        code: 0,
        signal: null,
        stdout: `${RESULT_MARKER}${JSON.stringify({ runId: contract.runId, taskFingerprint: contract.taskFingerprint, nonce: contract.nonce, summary })}`,
        stderr: "",
      },
    ],
  };
}

/**
 * The bridge under test. Given a finalized run terminal (the authority) and a
 * Cloudbox capability drift receipt (advisory), compose the combined report a
 * Cloud Terrarium cell would hand back. Authority rules live HERE, in one place:
 *
 *   - `ok` / `status` come ONLY from the terminal (verified TERRARIUM_RESULT).
 *   - the capability receipt is attached as advisory evidence and can NEVER
 *     change `ok` — it can only annotate.
 */
function bridgeReport(terminal, capabilityReceipt) {
  return {
    // Authority: copied verbatim from the task-contract terminal.
    status: terminal.status,
    ok: terminal.ok,
    taskContractStatus: terminal.taskContractStatus,
    // Advisory: capability drift evidence, clearly namespaced as non-authoritative.
    capability: capabilityReceipt
      ? {
          advisory: true,
          schema: capabilityReceipt.schema,
          source: capabilityReceipt.source,
          driftScore: capabilityReceipt.driftScore,
          taskCompleted: capabilityReceipt.taskCompleted,
          violations: capabilityReceipt.violations,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Invariant 0: Cloudbox-like backend output is wired through validateReceipt.
// ---------------------------------------------------------------------------

test("Cloudbox-like backend stdout reaches validateReceipt before success", async () => {
  const base = await loadFixture("run-clean.json");
  // The nonce is server-minted, so the backend must build its receipt from the
  // REAL cell's contract. Launch first to obtain the server-minted contract,
  // then point the fake backend at a receipt built from it.
  const stores = makeStores();
  const backend = new FakeCloudboxBackend(base);
  // Build the correlated receipt from the run's real server-minted contract.
  backend.buildResult = (contract) => withTerrariumResult(base, contract);
  stores.backend = backend;
  const cell = new TerrariumRunCell(stores);
  const { runId } = cell.launch({ task: "mint contract", ownerId: "owner-A" });
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "done");
  assert.equal(terminal.taskContractStatus, "verified");
  assert.equal(stores.logs.read(runId).includes(RESULT_MARKER), true);

  const envelope = await loadFixture("envelope.json");
  const capability = cloudboxRunToReceipt({ result: base, envelope, root: ROOT, runId });
  assert.equal(capability.schema, "terrarium-drift-lab-receipt-v0");
});

// ---------------------------------------------------------------------------
// Invariant 1: verified TERRARIUM_RESULT is the SOLE success authority.
// ---------------------------------------------------------------------------

test("verified receipt is the sole authority even when the capability receipt is spotless", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "cloudbox docs fix", ownerId: "owner-A" });
  const terminal = await cell.collect(runId);

  // A perfectly clean Cloudbox run: ok:true, no drift, taskCompleted.
  const cleanResult = await loadFixture("run-clean.json");
  const envelope = await loadFixture("envelope.json");
  const capability = cloudboxRunToReceipt({ result: cleanResult, envelope, root: ROOT, runId });
  assert.equal(capability.driftScore, 1);
  assert.equal(capability.taskCompleted, true);

  const report = bridgeReport(terminal, capability);
  // Authority is the verified receipt, not the spotless capability receipt.
  assert.equal(report.ok, true);
  assert.equal(report.status, "done");
  assert.equal(report.taskContractStatus, "verified");
  assert.equal(report.capability.advisory, true);
});

test("a spotless capability receipt cannot UPGRADE an inconclusive terminal to done", async () => {
  const cell = makeCell();
  // Child exits 0 but emits NO correlated receipt => inconclusive.
  const { runId } = cell.launch({
    task: "cloudbox no-receipt",
    ownerId: "owner-A",
    spec: { exitCode: 0, emitReceipt: false },
  });
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "inconclusive");

  // Even a flawless capability receipt (driftScore 1, taskCompleted) must not
  // launder the missing task contract into success.
  const cleanResult = await loadFixture("run-clean.json");
  const envelope = await loadFixture("envelope.json");
  const capability = cloudboxRunToReceipt({ result: cleanResult, envelope, root: ROOT, runId });
  assert.equal(capability.taskCompleted, true);

  const report = bridgeReport(terminal, capability);
  assert.equal(report.ok, false);
  assert.equal(report.status, "inconclusive");
  assert.equal(report.taskContractStatus, "missing");
});

// ---------------------------------------------------------------------------
// Invariant 2: Cloudbox ok:true ALONE is inconclusive.
// ---------------------------------------------------------------------------

test("Cloudbox ok:true alone is inconclusive without a matching TERRARIUM_RESULT", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({
    task: "cloudbox ok is not authority",
    ownerId: "owner-A",
    spec: { exitCode: 0, emitReceipt: false },
  });
  const terminal = await cell.collect(runId);

  const cleanResult = await loadFixture("run-clean.json");
  const envelope = await loadFixture("envelope.json");
  // Model reality: the Cloudbox backend genuinely returned ok:true.
  assert.equal(cleanResult.ok, true);
  const capability = cloudboxRunToReceipt({ result: cleanResult, envelope, root: ROOT, runId });

  const report = bridgeReport(terminal, capability);
  // Cloudbox ok:true + capability taskCompleted:true, yet the run is inconclusive.
  assert.equal(cleanResult.ok, true);
  assert.equal(capability.taskCompleted, true);
  assert.equal(report.ok, false);
  assert.equal(report.status, "inconclusive");
});

test("Cloudbox ok:true with a mismatched receipt (wrong nonce) is inconclusive", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({
    task: "cloudbox mismatched nonce",
    ownerId: "owner-A",
    spec: { exitCode: 0, receiptOverride: { nonce: "forged-nonce" } },
  });
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "inconclusive");
  assert.equal(terminal.taskContractStatus, "mismatch");
  // No capability receipt can rescue a forged correlation.
  const report = bridgeReport(terminal, null);
  assert.equal(report.ok, false);
});

// ---------------------------------------------------------------------------
// Invariant 3: the capability drift receipt is ADVISORY (v0).
// ---------------------------------------------------------------------------

test("capability drift is advisory v0 and does NOT downgrade a verified terminal", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "cloudbox drifty-but-verified", ownerId: "owner-A" });
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "done");

  // A drifty Cloudbox run: reads /etc/passwd, writes a backdoor, touches policy,
  // runs curl, verify fails => driftScore 0.2, taskCompleted:false, many violations.
  const driftResult = await loadFixture("run-drift.json");
  const envelope = await loadFixture("envelope.json");
  const capability = cloudboxRunToReceipt({ result: driftResult, envelope, root: ROOT, runId });
  assert.equal(capability.schema, "terrarium-drift-lab-receipt-v0"); // explicitly v0
  assert.equal(capability.driftScore, 0.2);
  assert.equal(capability.taskCompleted, false);
  assert.ok(capability.violations.length > 0);

  const report = bridgeReport(terminal, capability);
  // Advisory: capability drift rides alongside but the terminal authority holds.
  assert.equal(report.ok, true);
  assert.equal(report.status, "done");
  assert.equal(report.taskContractStatus, "verified");
  assert.equal(report.capability.advisory, true);
  assert.equal(report.capability.taskCompleted, false); // evidence preserved, not enforced
  assert.ok(report.capability.violations.length > 0);
});

test("advisory capability receipt is inert on the durable terminal and callback", async () => {
  const stores = makeStores();
  const cell = new TerrariumRunCell(stores);
  const { runId } = cell.launch({ task: "cloudbox advisory-inert", ownerId: "owner-A" });
  cell.subscribe("sub", { runId, ownerId: "owner-A" });
  const terminal = await cell.collect(runId);

  // Computing/attaching a drift receipt is a pure side-effect-free read; it must
  // not touch the committed terminal or the callback journal.
  const driftResult = await loadFixture("run-drift.json");
  const envelope = await loadFixture("envelope.json");
  cloudboxRunToReceipt({ result: driftResult, envelope, root: ROOT, runId });

  const durable = stores.state.get(runId);
  assert.equal(durable.status, "done");
  assert.equal(durable.terminal.taskContractStatus, "verified");

  // Still exactly one terminal callback; the advisory receipt emitted none.
  const events = cell.collectCallbacks("sub");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, `evt_${runId}_terminal`);
});

// ---------------------------------------------------------------------------
// Invariant 4: terminal callback emitted EXACTLY ONCE and OWNER-SCOPED.
// ---------------------------------------------------------------------------

test("terminal callback is emitted exactly once across duplicate collect + reconcile", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "cloudbox single-callback", ownerId: "owner-A" });
  cell.subscribe("sub", { runId, ownerId: "owner-A" });

  // Concurrent + repeat collects, then a reconcile: still one delivery.
  await Promise.all([cell.collect(runId), cell.collect(runId), cell.collect(runId)]);
  await cell.collect(runId);
  const recon = cell.reconcile(runId);
  assert.equal(recon.repaired, false);
  assert.equal(recon.deduped, true);

  const events = cell.collectCallbacks("sub");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, `evt_${runId}_terminal`);
  assert.equal(events[0].type, "run.finished");
  assert.equal(events[0].status, "done");
  assert.equal(events[0].ok, true);

  // Draining is exhaustive: a second collect yields nothing more.
  assert.equal(cell.collectCallbacks("sub").length, 0);
});

test("terminal callback is owner-scoped: a cross-owner subscriber sees nothing", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "cloudbox owner-scoped", ownerId: "owner-A" });
  cell.subscribe("owner-sub", { runId, ownerId: "owner-A" });
  cell.subscribe("intruder-sub", { runId, ownerId: "owner-B" });

  await cell.collect(runId);

  assert.equal(cell.collectCallbacks("owner-sub").length, 1);
  assert.equal(cell.collectCallbacks("intruder-sub").length, 0);

  // Owner-scoped status read still fails closed for the other owner.
  assert.throws(() => cell.status(runId, "owner-B"), (err) => err.code === "EACCES");
});

test("owner-scoped terminal callback replays after finish-before-subscribe", async () => {
  const cell = makeCell();
  const { runId } = cell.launch({ task: "cloudbox late-subscribe", ownerId: "owner-A" });

  // Finalize BEFORE any subscriber attaches.
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "done");

  // Correct owner subscribes late: durable journal replays exactly one event.
  cell.subscribe("late-owner", { runId, ownerId: "owner-A" });
  // Wrong owner subscribes late: replay is filtered to nothing.
  cell.subscribe("late-intruder", { runId, ownerId: "owner-B" });

  assert.equal(cell.collectCallbacks("late-owner").length, 1);
  assert.equal(cell.collectCallbacks("late-intruder").length, 0);
});

test("failed cloudbox run (drift receipt taskCompleted:false) still emits one owner callback", async () => {
  // A Cloudbox run whose child never produced a correlated receipt is
  // inconclusive; the terminal callback still fires exactly once, owner-scoped,
  // carrying the non-success status.
  const cell = makeCell();
  const { runId } = cell.launch({
    task: "cloudbox failed-run callback",
    ownerId: "owner-A",
    spec: { exitCode: 1, emitReceipt: false },
  });
  cell.subscribe("sub", { runId, ownerId: "owner-A" });
  cell.subscribe("intruder", { runId, ownerId: "owner-B" });

  const terminal = await cell.collect(runId);
  assert.equal(terminal.ok, false);
  assert.equal(terminal.status, "failed");

  const owner = cell.collectCallbacks("sub");
  assert.equal(owner.length, 1);
  assert.equal(owner[0].ok, false);
  assert.equal(owner[0].status, "failed");
  assert.equal(cell.collectCallbacks("intruder").length, 0);
});

// ---------------------------------------------------------------------------
// Cross-cutting: logs carry the authoritative marker while the capability
// receipt is derived purely from the (separate) Cloudbox diff/receipts.
// ---------------------------------------------------------------------------

test("authority lives in the persisted TERRARIUM_RESULT, capability evidence in the Cloudbox diff", async () => {
  const stores = makeStores();
  const cell = new TerrariumRunCell(stores);
  const { runId } = cell.launch({ task: "cloudbox two-channels", ownerId: "owner-A" });
  await cell.collect(runId);

  // Channel 1 (authority): the correlated marker sits in the persisted log store.
  assert.ok(cell.logs(runId).includes(RESULT_MARKER));

  // Channel 2 (advisory): the capability receipt is a pure function of the
  // Cloudbox result + envelope and carries no TERRARIUM_RESULT authority.
  const cleanResult = await loadFixture("run-clean.json");
  const envelope = await loadFixture("envelope.json");
  const capability = cloudboxRunToReceipt({ result: cleanResult, envelope, root: ROOT, runId });
  assert.equal(JSON.stringify(capability).includes(RESULT_MARKER), false);
  assert.equal(capability.source, "cloudbox");
});
