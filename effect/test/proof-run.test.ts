import assert from "node:assert/strict";
import test from "node:test";

import { terminalOf } from "../src/run-workflow-terminal.ts";
import type { RunContract } from "../src/shared.ts";

const contract: RunContract = { runId: "ter_abc123_0123456789ab", taskFingerprint: "f", nonce: "n0nce" };

const receipt = (summary: string) => `TASK_RECEIVED\nTERRARIUM_RESULT=${JSON.stringify({ nonce: contract.nonce, summary })}\nTASK_ENDED`;

const run = (proofExit: number | null | "none", summary = "All tests pass. Done.") =>
  terminalOf({ output: receipt(summary), exitCode: 0, proof: proofExit === "none" ? null : { command: "npm test", exitCode: proofExit, output: "" } }, contract, "t").terminal;

test("a run with a valid receipt but a failing proof is failed", () => {
  const terminal = run(1);

  assert.equal(terminal.provenance, "this-run");
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.proof?.exitCode, 1);
});

test("a run whose proof could not run is failed", () => {
  assert.equal(run(null).status, "failed");
});

test("a run with a valid receipt and proof exit 0 is done", () => {
  assert.equal(run(0).status, "done");
});

test("a run without a proof keeps the receipt-only behaviour", () => {
  assert.equal(run("none").status, "done");
});

test("a failing proof cannot be rescued by a receipt from another run", () => {
  const terminal = terminalOf({ output: receipt("ok").replace("n0nce", "other"), exitCode: 0, proof: { command: "true", exitCode: 0, output: "" } }, contract, "t").terminal;

  assert.equal(terminal.provenance, "mismatch");
  assert.equal(terminal.status, "failed");
});
