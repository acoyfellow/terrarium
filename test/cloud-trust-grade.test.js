import test from "node:test";
import assert from "node:assert/strict";
import { composeTrustGrade } from "../src/cloud/trust-grade.js";
import { computeCorrectnessAnnotation } from "../src/cloud/correctness-annotation.js";

const trusted = computeCorrectnessAnnotation({ answers: ["5", "5", "5"], models: ["a", "b", "c"], gate: "unanimous" });
const unknown = computeCorrectnessAnnotation({ answers: ["5", "6", "7"], models: ["a", "b", "c"], gate: "unanimous" });

test("verified provenance + trusted correctness => TRUSTED", () => {
  const g = composeTrustGrade({ provenance: "verified", correctness: trusted });
  assert.equal(g.grade, "trusted");
  assert.equal(g.trustworthy, true);
});

test("verified provenance + unknown correctness => provenance-only (fail closed, not trusted)", () => {
  const g = composeTrustGrade({ provenance: "verified", correctness: unknown });
  assert.equal(g.grade, "provenance-only");
  assert.equal(g.trustworthy, true);
});

test("verified provenance + NO correctness => provenance-only", () => {
  const g = composeTrustGrade({ provenance: "verified", correctness: null });
  assert.equal(g.grade, "provenance-only");
});

test("WEAKEST WINS: trusted correctness CANNOT lift a missing/mismatch provenance", () => {
  for (const prov of ["missing", "malformed", "mismatch"]) {
    const g = composeTrustGrade({ provenance: prov, correctness: trusted });
    assert.equal(g.grade, "none", `${prov} must stay none`);
    assert.equal(g.trustworthy, false);
  }
});

test("non-advisory correctness object is floored to unknown (cannot be laundered)", () => {
  // an attacker hands a fake { verdict: 'trusted' } WITHOUT advisory:true
  const g = composeTrustGrade({ provenance: "verified", correctness: { verdict: "trusted" } });
  assert.equal(g.grade, "provenance-only", "non-advisory verdict must be ignored");
});

test("unknown provenance value defaults to missing (fail closed)", () => {
  const g = composeTrustGrade({ provenance: "totally-bogus", correctness: trusted });
  assert.equal(g.grade, "none");
});

test("not-applicable / not-required provenance is not a success warrant", () => {
  for (const prov of ["not-applicable", "not-required"]) {
    const g = composeTrustGrade({ provenance: prov, correctness: trusted });
    assert.equal(g.grade, "none", `${prov} is not task-success provenance`);
  }
});
