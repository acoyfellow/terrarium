// Shard-P Go-vs-TS replay conformance: cross-language run-machine parity.
//
// Wow hardening round 4, shard P. The Go core now exposes a `replay` command
// (internal/protocol) that drives a fixed sequence of already-observed inputs
// through the pure Go run machine (internal/run) and returns the final terminal
// classification plus per-step decisions. This suite feeds the SAME input
// sequences to the TS transition() core (src/run-machine.js) and the Go core,
// then asserts they agree byte-for-byte on the terminal classification fields
// that consumers reconstruct from (status, ok, taskContractStatus,
// taskResultSummary, reason, exitCode).
//
// This is the conformance net that would have caught the cancelled/deadlined
// "verified receipt survives as verified" drift the Go run-machine fix closed:
// the two cores are now driven by identical sequences and compared directly,
// not merely asserted equivalent at the initial-state level (shard A).
//
// Go overlap is conditional: if `go` is unavailable (and no TEST_TERRARIUM_GO_CORE
// override is set) the Go-comparison assertions skip rather than fail, so the
// suite stays CI-portable. The TS-only sequence assertions always run.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialRunState, transition } from "../src/run-machine.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Conformance sequences: each is a name + requireReceipt flag + ordered inputs.
// Cover every terminal classification path and the ordering-sensitive races.
const SEQUENCES = [
  {
    name: "verified-receipt-done",
    requireReceipt: true,
    inputs: [
      { type: "ChildExited", exitCode: 0 },
      { type: "ReceiptObserved", status: "verified", summary: "shipped" },
    ],
  },
  {
    name: "receipt-before-exit-done",
    requireReceipt: true,
    inputs: [
      { type: "ReceiptObserved", status: "verified", summary: "shipped" },
      { type: "ChildExited", exitCode: 0 },
    ],
  },
  {
    name: "missing-receipt-inconclusive",
    requireReceipt: true,
    inputs: [
      { type: "ChildExited", exitCode: 0 },
      { type: "ReceiptObserved", status: "missing" },
    ],
  },
  {
    name: "mismatch-receipt-inconclusive",
    requireReceipt: true,
    inputs: [
      { type: "ChildExited", exitCode: 0 },
      { type: "ReceiptObserved", status: "mismatch" },
    ],
  },
  {
    name: "malformed-receipt-inconclusive",
    requireReceipt: true,
    inputs: [
      { type: "ChildExited", exitCode: 0 },
      { type: "ReceiptObserved", status: "malformed" },
    ],
  },
  {
    name: "verified-but-nonzero-exit-failed",
    requireReceipt: true,
    inputs: [
      { type: "ChildExited", exitCode: 2 },
      { type: "ReceiptObserved", status: "verified", summary: "ran" },
    ],
  },
  {
    name: "no-receipt-required-done",
    requireReceipt: false,
    inputs: [{ type: "ChildExited", exitCode: 0 }],
  },
  {
    name: "cancel-then-receipt-then-exit-not-applicable",
    requireReceipt: true,
    inputs: [
      { type: "CancelRequested" },
      { type: "ReceiptObserved", status: "verified", summary: "win" },
      { type: "ChildExited", exitCode: 0 },
    ],
  },
  {
    name: "receipt-then-cancel-then-exit-not-applicable",
    requireReceipt: true,
    inputs: [
      { type: "ReceiptObserved", status: "verified", summary: "win" },
      { type: "CancelRequested" },
      { type: "ChildExited", exitCode: 0 },
    ],
  },
  {
    name: "receipt-then-deadline-then-exit-not-applicable",
    requireReceipt: true,
    inputs: [
      { type: "ReceiptObserved", status: "verified", summary: "win" },
      { type: "DeadlineReached" },
      { type: "ChildExited", exitCode: 0 },
    ],
  },
  {
    name: "clean-exit-then-late-cancel-ignored",
    requireReceipt: true,
    inputs: [
      { type: "ChildExited", exitCode: 0 },
      { type: "ReceiptObserved", status: "verified", summary: "done" },
      { type: "CancelRequested" },
    ],
  },
  {
    name: "runtime-error",
    requireReceipt: true,
    inputs: [{ type: "RuntimeError", error: "spawn failed" }],
  },
];

// The cross-core comparison surface: only the consumer-facing terminal fields.
function tsTerminal(seq) {
  let state = initialRunState({ requireReceipt: seq.requireReceipt });
  for (const input of seq.inputs) {
    ({ state } = transition(state, input));
  }
  return state.terminal;
}

function projectTerminal(t) {
  if (!t) return null;
  return {
    status: t.status,
    ok: !!t.ok,
    exitCode: t.exitCode ?? null,
    taskContractStatus: t.taskContractStatus ?? "",
    taskResultSummary: t.taskResultSummary ?? "",
    reason: t.reason ?? "",
  };
}

function resolveGoBinary() {
  if (process.env.TEST_TERRARIUM_GO_CORE) return process.env.TEST_TERRARIUM_GO_CORE;
  const out = join(tmpdir(), "terra-core-shardP-test");
  const b = spawnSync("go", ["build", "-o", out, "./cmd/terra-core"], { cwd: repoRoot, encoding: "utf8" });
  return b.status === 0 ? out : null;
}

function goReplay(bin, seq) {
  const cmd = { command: "replay", requireReceipt: seq.requireReceipt, inputs: seq.inputs };
  const r = spawnSync(bin, ["--stdin"], { input: JSON.stringify(cmd), encoding: "utf8", timeout: 5000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout || ""); } catch {}
  return { status: r.status, parsed };
}

test("shard-P: TS replay produces the expected terminal classification per sequence", () => {
  const expected = {
    "verified-receipt-done": { status: "done", ok: true, taskContractStatus: "verified", reason: "verified-receipt" },
    "receipt-before-exit-done": { status: "done", ok: true, taskContractStatus: "verified", reason: "verified-receipt" },
    "missing-receipt-inconclusive": { status: "inconclusive", ok: false, taskContractStatus: "missing" },
    "mismatch-receipt-inconclusive": { status: "inconclusive", ok: false, taskContractStatus: "mismatch" },
    "malformed-receipt-inconclusive": { status: "inconclusive", ok: false, taskContractStatus: "malformed" },
    "verified-but-nonzero-exit-failed": { status: "failed", ok: false, taskContractStatus: "verified" },
    "no-receipt-required-done": { status: "done", ok: true, taskContractStatus: "not-required" },
    "cancel-then-receipt-then-exit-not-applicable": { status: "cancelled", ok: false, taskContractStatus: "not-applicable" },
    "receipt-then-cancel-then-exit-not-applicable": { status: "cancelled", ok: false, taskContractStatus: "not-applicable" },
    "receipt-then-deadline-then-exit-not-applicable": { status: "failed", ok: false, taskContractStatus: "not-applicable" },
    "clean-exit-then-late-cancel-ignored": { status: "done", ok: true, taskContractStatus: "verified" },
    "runtime-error": { status: "error", ok: false },
  };
  for (const seq of SEQUENCES) {
    const t = projectTerminal(tsTerminal(seq));
    assert.ok(t, `${seq.name}: should reach terminal`);
    const exp = expected[seq.name];
    for (const [k, v] of Object.entries(exp)) {
      assert.equal(t[k], v, `${seq.name}: ${k}`);
    }
    // The cancelled/deadlined truth invariant: a terminated run never leaks a summary.
    if (t.taskContractStatus === "not-applicable") {
      assert.equal(t.taskResultSummary, "", `${seq.name}: terminated run leaks no summary`);
    }
  }
});

test("shard-P: Go core replay agrees with TS transition on every sequence (skipped if go unavailable)", (t) => {
  const bin = resolveGoBinary();
  if (!bin) { t.skip("go core unavailable (no go toolchain and no TEST_TERRARIUM_GO_CORE)"); return; }

  for (const seq of SEQUENCES) {
    const go = goReplay(bin, seq);
    assert.equal(go.status, 0, `${seq.name}: go replay exit 0`);
    assert.equal(go.parsed?.ok, true, `${seq.name}: go replay ok`);
    assert.equal(go.parsed?.replay?.machineVersion, initialRunState({}).version, `${seq.name}: machine version parity`);

    const goTerm = projectTerminal(go.parsed?.replay?.terminal);
    const tsTerm = projectTerminal(tsTerminal(seq));
    assert.deepEqual(goTerm, tsTerm, `${seq.name}: Go/TS terminal classification parity`);
  }
});

test("shard-P: Go replay rejects a malformed input the same way TS transition throws (skipped if go unavailable)", (t) => {
  const bin = resolveGoBinary();
  if (!bin) { t.skip("go core unavailable"); return; }

  // TS: ChildExited without an integer exitCode throws.
  assert.throws(() => transition(initialRunState({}), { type: "ChildExited" }), /ChildExited requires integer exitCode/);

  // Go: same bad input is a clean per-index failure response, not a crash.
  const go = goReplay(bin, { requireReceipt: true, inputs: [{ type: "ChildExited" }] });
  assert.equal(go.parsed?.ok, false, "go replay rejects bad input");
  assert.match(go.parsed?.error || "", /inputs\[0\]/, "go error indexes the bad input");
});
