import test from "node:test";
import assert from "node:assert/strict";
import { mintReceiptArtifact, verifyReceiptArtifact, _internals } from "../src/cloud/receipt-artifact.js";
import { computeCorrectnessAnnotation } from "../src/cloud/correctness-annotation.js";

const contract = { runId: "ter_abc123", taskFingerprint: "fp0011223344556677889900", nonce: "n-xyz-1" };
const verifiedTerminal = { status: "done", ok: true, taskContractStatus: "verified", reason: "verified-receipt", taskResultSummary: "391" };
const trusted = computeCorrectnessAnnotation({ answers: ["391", "391", "391"], models: ["a", "b", "c"], gate: "unanimous" });

test("minted artifact id is the content hash and re-verifies with only the artifact", async () => {
  const art = await mintReceiptArtifact({ contract, terminal: verifiedTerminal, correctness: trusted });
  assert.match(art.artifactId, /^[a-f0-9]{64}$/);
  const v = await verifyReceiptArtifact(art);
  assert.equal(v.ok, true);
  assert.equal(v.checks.contentHash, true);
  assert.equal(v.checks.gradeConsistent, true);
  assert.equal(art.body.grade.grade, "trusted");
});

test("any tamper of the body breaks the content hash (non-forgeable id)", async () => {
  const art = await mintReceiptArtifact({ contract, terminal: verifiedTerminal, correctness: trusted });
  // flip the answer summary but keep the id
  art.body.terminal.summary = "tampered";
  const v = await verifyReceiptArtifact(art);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "content-hash-mismatch");
});

test("laundering the grade up is caught by grade recompute", async () => {
  // missing provenance, but attacker sets grade.trustworthy true + regenerates id
  const missingTerminal = { status: "inconclusive", ok: false, taskContractStatus: "missing", reason: "receipt-missing" };
  const art = await mintReceiptArtifact({ contract, terminal: missingTerminal, correctness: trusted });
  // honest mint should already be grade "none"
  assert.equal(art.body.grade.grade, "none");
  // attacker rewrites the grade to trusted AND recomputes a valid content hash
  art.body.grade = { grade: "trusted", provenance: "missing", correctness: "trusted", trustworthy: true };
  art.artifactId = await _internals.sha256Hex(_internals.canonical(art.body));
  const v = await verifyReceiptArtifact(art);
  // content hash now matches, but grade recompute disagrees -> caught
  assert.equal(v.ok, false);
  assert.equal(v.reason, "grade-inconsistent");
});

test("malformed correlation triple fails closed", async () => {
  const art = await mintReceiptArtifact({ contract, terminal: verifiedTerminal, correctness: null });
  art.body.contract.runId = "bad id with spaces!";
  art.artifactId = await _internals.sha256Hex(_internals.canonical(art.body));
  const v = await verifyReceiptArtifact(art);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "malformed-triple");
});

test("mint refuses an incomplete correlation triple", async () => {
  await assert.rejects(() => mintReceiptArtifact({ contract: { runId: "x" }, terminal: verifiedTerminal }), /triple/);
});

test("canonical json is order-independent (stable content address)", async () => {
  const a = await mintReceiptArtifact({ contract, terminal: verifiedTerminal, correctness: null });
  const b = await mintReceiptArtifact({ contract: { nonce: contract.nonce, runId: contract.runId, taskFingerprint: contract.taskFingerprint }, terminal: verifiedTerminal, correctness: null });
  assert.equal(a.artifactId, b.artifactId, "key order must not change the content address");
});
