import test from "node:test";
import assert from "node:assert/strict";
import { lookupCalibration, attachCalibration } from "../src/cloud/trust-calibration.js";
import { composeTrustGrade } from "../src/cloud/trust-grade.js";
import { computeCorrectnessAnnotation } from "../src/cloud/correctness-annotation.js";

test("calibrated mechanism carries its measured false-trust posture", () => {
  const ann = computeCorrectnessAnnotation({ answers: ["5", "5", "5"], models: ["a", "b", "c"], gate: "majority" });
  const grade = composeTrustGrade({ provenance: "verified", correctness: ann });
  const out = attachCalibration(grade, ann);
  assert.equal(out.calibrated, true);
  assert.equal(out.calibration.mechanism, "cross-model-agreement");
  assert.equal(out.calibration.gate, "majority");
  assert.equal(out.calibration.measuredFalseTrust, 0.0);
  assert.equal(out.calibration.label, "LOCAL-ONLY");
});

test("uncalibrated mechanism fails closed: calibration null, calibrated false", () => {
  const ann = { advisory: true, verdict: "trusted", mechanism: "some-new-untested-mechanism", gate: "unanimous" };
  const grade = composeTrustGrade({ provenance: "verified", correctness: ann });
  const out = attachCalibration(grade, ann);
  assert.equal(out.calibrated, false);
  assert.equal(out.calibration, null);
});

test("no annotation => uncalibrated (never claims 0% by default)", () => {
  const grade = composeTrustGrade({ provenance: "verified", correctness: null });
  const out = attachCalibration(grade, null);
  assert.equal(out.calibrated, false);
  assert.equal(out.calibration, null);
});

test("single-run baseline calibration reflects the measured 16.7% false-trust", () => {
  const cal = lookupCalibration("single-run", "none");
  assert.equal(cal.falseTrust, 0.167);
  assert.equal(cal.wrongTrusted, 2);
  assert.equal(cal.label, "LOCAL-ONLY");
});

test("attaching calibration never changes the underlying grade/authority", () => {
  const ann = computeCorrectnessAnnotation({ answers: ["5", "6", "7"], models: ["a", "b", "c"], gate: "unanimous" }); // unknown
  const grade = composeTrustGrade({ provenance: "verified", correctness: ann });
  const out = attachCalibration(grade, ann);
  assert.equal(out.grade, grade.grade); // provenance-only, unchanged
  assert.equal(out.trustworthy, grade.trustworthy);
  assert.equal(out.provenance, "verified");
});

test("calibration is advisory metadata about the MECHANISM, not a per-answer guarantee", () => {
  // Even a 0% measured mechanism, on a WRONG-but-decisive answer, must not claim
  // the individual answer is guaranteed correct — the grade stays as composed and
  // the calibration is clearly a mechanism-level rate with a dataset + LOCAL-ONLY label.
  const ann = computeCorrectnessAnnotation({ answers: ["wrong", "wrong", "wrong"], models: ["a", "b", "c"], gate: "unanimous" });
  const grade = composeTrustGrade({ provenance: "verified", correctness: ann });
  const out = attachCalibration(grade, ann);
  assert.equal(out.calibration.measuredFalseTrust, 0.0);
  assert.ok(out.calibration.dataset.includes("accuracy-bench"));
  assert.equal(out.calibration.label, "LOCAL-ONLY");
});
