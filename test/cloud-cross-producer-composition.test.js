// E3 (proof-carrying, Stage 2/3): cross-producer composition. Two INDEPENDENT
// producers each mint a graded, content-addressed artifact; a third party
// composes them weakest-wins with ONLY the artifacts (no run/DO/network) and
// the grade survives the crossing, cannot be laundered up, and fails closed.
//
// Producer A: a "run" producer -> provenance receipt artifact.
// Producer B: a "checker" producer -> correctness annotation.
// Consumer: composes A's provenance with B's correctness into one grade, then
// re-verifies A's artifact independently. This is the "protocol between
// producers wins" bet at toy scale.

import test from "node:test";
import assert from "node:assert/strict";
import { mintReceiptArtifact, verifyReceiptArtifact } from "../src/cloud/receipt-artifact.js";
import { computeCorrectnessAnnotation } from "../src/cloud/correctness-annotation.js";
import { composeTrustGrade } from "../src/cloud/trust-grade.js";

const contract = { runId: "ter_prodA_1", taskFingerprint: "fpAAAABBBBCCCCDDDDEEEE1122", nonce: "nonceA1" };

// Consumer-side composition: takes producer A's receipt artifact + producer B's
// correctness annotation, verifies A independently, then composes the grade.
async function consumerCompose(receiptArtifact, correctnessFromB) {
  const v = await verifyReceiptArtifact(receiptArtifact);
  if (!v.ok) return { accepted: false, reason: `artifact failed re-verify: ${v.reason}` };
  const grade = composeTrustGrade({
    provenance: receiptArtifact.body.terminal.taskContractStatus,
    correctness: correctnessFromB,
  });
  return { accepted: true, grade };
}

test("E3: verified run (A) + trusted checker (B) => consumer grade TRUSTED", async () => {
  const artifactA = await mintReceiptArtifact({
    contract, terminal: { status: "done", ok: true, taskContractStatus: "verified", taskResultSummary: "42" }, correctness: null,
  });
  const correctnessB = computeCorrectnessAnnotation({ answers: ["42", "42", "42"], models: ["m1", "m2", "m3"], gate: "unanimous" });
  const out = await consumerCompose(artifactA, correctnessB);
  assert.equal(out.accepted, true);
  assert.equal(out.grade.grade, "trusted");
  assert.equal(out.grade.trustworthy, true);
});

test("E3: verified run (A) + disagreeing checker (B) => consumer grade PROVENANCE-ONLY (fail closed)", async () => {
  const artifactA = await mintReceiptArtifact({
    contract, terminal: { status: "done", ok: true, taskContractStatus: "verified", taskResultSummary: "42" }, correctness: null,
  });
  const correctnessB = computeCorrectnessAnnotation({ answers: ["42", "43", "44"], models: ["m1", "m2", "m3"], gate: "unanimous" });
  const out = await consumerCompose(artifactA, correctnessB);
  assert.equal(out.grade.grade, "provenance-only");
  assert.equal(out.grade.correctness, "unknown");
});

test("E3: NON-launderable across the boundary — trusted checker cannot rescue a missing run", async () => {
  const artifactA = await mintReceiptArtifact({
    contract, terminal: { status: "inconclusive", ok: false, taskContractStatus: "missing", reason: "receipt-missing" }, correctness: null,
  });
  const correctnessB = computeCorrectnessAnnotation({ answers: ["42", "42", "42"], models: ["m1", "m2", "m3"], gate: "unanimous" });
  const out = await consumerCompose(artifactA, correctnessB);
  assert.equal(out.accepted, true, "artifact itself is intact and re-verifies");
  assert.equal(out.grade.grade, "none", "but weakest-wins keeps a missing run at none");
  assert.equal(out.grade.trustworthy, false);
});

test("E3: a tampered producer-A artifact is REJECTED before any composition", async () => {
  const artifactA = await mintReceiptArtifact({
    contract, terminal: { status: "done", ok: true, taskContractStatus: "verified", taskResultSummary: "42" }, correctness: null,
  });
  // man-in-the-middle flips the provenance to look verified elsewhere but keeps id
  artifactA.body.terminal.taskContractStatus = "verified";
  artifactA.body.terminal.summary = "999";
  const correctnessB = computeCorrectnessAnnotation({ answers: ["999", "999", "999"], models: ["m1", "m2", "m3"], gate: "unanimous" });
  const out = await consumerCompose(artifactA, correctnessB);
  assert.equal(out.accepted, false);
  assert.match(out.reason, /re-verify/);
});

test("E3: consumer needs ONLY the artifact + annotation (no run/DO handle)", async () => {
  // Serialize across the "wire" (JSON round-trip) to prove no live objects needed.
  const artifactA = await mintReceiptArtifact({
    contract, terminal: { status: "done", ok: true, taskContractStatus: "verified", taskResultSummary: "42" }, correctness: null,
  });
  const wire = JSON.parse(JSON.stringify(artifactA));
  const correctnessB = JSON.parse(JSON.stringify(computeCorrectnessAnnotation({ answers: ["42", "42"], models: ["m1", "m2"], gate: "unanimous" })));
  // correctnessB lost its frozen-ness over the wire but keeps advisory:true
  const out = await consumerCompose(wire, correctnessB);
  assert.equal(out.accepted, true);
  assert.equal(out.grade.grade, "trusted");
});
