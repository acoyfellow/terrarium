import test from "node:test";
import assert from "node:assert/strict";
import { buildGradedReceipt } from "../src/cloud/graded-receipt.js";
import { verifyReceiptArtifact } from "../src/cloud/receipt-artifact.js";
import { computeCorrectnessAnnotation } from "../src/cloud/correctness-annotation.js";

const contract = { runId: "ter_graded_1", taskFingerprint: "fp112233445566778899aabb", nonce: "n-g-1" };
const verified = { status: "done", ok: true, taskContractStatus: "verified", reason: "verified-receipt", taskResultSummary: "42" };

test("verified + trusted+calibrated => grade trusted, calibrated, artifact re-verifies", async () => {
  const correctness = computeCorrectnessAnnotation({ answers: ["42", "42", "42"], models: ["a", "b", "c"], gate: "majority" });
  const out = await buildGradedReceipt({ contract, terminal: verified, correctness });
  assert.equal(out.grade.grade, "trusted");
  assert.equal(out.grade.calibrated, true);
  assert.equal(out.grade.calibration.measuredFalseTrust, 0.0);
  assert.equal(out.terminal.correctness.verdict, "trusted");
  // authority untouched
  assert.equal(out.terminal.taskContractStatus, "verified");
  const v = await verifyReceiptArtifact(out.artifact);
  assert.equal(v.ok, true);
});

test("no correctness => provenance-only, uncalibrated (fail closed), still artifacted", async () => {
  const out = await buildGradedReceipt({ contract, terminal: verified, correctness: null });
  assert.equal(out.grade.grade, "provenance-only");
  assert.equal(out.grade.calibrated, false);
  assert.equal(out.grade.calibration, null);
  assert.equal(out.terminal.correctness, undefined);
  const v = await verifyReceiptArtifact(out.artifact);
  assert.equal(v.ok, true);
});

test("missing provenance cannot be lifted by trusted correctness (weakest-wins end to end)", async () => {
  const missing = { status: "inconclusive", ok: false, taskContractStatus: "missing", reason: "receipt-missing" };
  const correctness = computeCorrectnessAnnotation({ answers: ["42", "42", "42"], models: ["a", "b", "c"], gate: "unanimous" });
  const out = await buildGradedReceipt({ contract, terminal: missing, correctness });
  assert.equal(out.grade.grade, "none");
  assert.equal(out.grade.trustworthy, false);
  // authority still missing; advisory correctness recorded but inert on authority
  assert.equal(out.terminal.taskContractStatus, "missing");
});

test("the graded receipt never changes ok/status/taskContractStatus", async () => {
  const correctness = computeCorrectnessAnnotation({ answers: ["1", "2", "3"], models: ["a", "b", "c"], gate: "unanimous" }); // unknown
  const out = await buildGradedReceipt({ contract, terminal: verified, correctness });
  assert.equal(out.terminal.ok, true);
  assert.equal(out.terminal.status, "done");
  assert.equal(out.terminal.taskContractStatus, "verified");
  assert.equal(out.grade.grade, "provenance-only"); // unknown correctness doesn't downgrade authority, just no upgrade
});
