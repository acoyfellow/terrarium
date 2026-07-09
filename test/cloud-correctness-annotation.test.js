import test from "node:test";
import assert from "node:assert/strict";
import { computeCorrectnessAnnotation, applyCorrectnessAnnotation } from "../src/cloud/correctness-annotation.js";

test("unanimous agreement => trusted; any disagreement => unknown (fail closed)", () => {
  const models = ["a", "b", "c"];
  const yes = computeCorrectnessAnnotation({ answers: ["391", "391", "391"], models, gate: "unanimous" });
  assert.equal(yes.verdict, "trusted");
  assert.equal(yes.agreement, 3);
  const no = computeCorrectnessAnnotation({ answers: ["391", "392", "391"], models, gate: "unanimous" });
  assert.equal(no.verdict, "unknown");
});

test("majority 2-of-3 => trusted; tie/no-majority => unknown", () => {
  const models = ["a", "b", "c"];
  const maj = computeCorrectnessAnnotation({ answers: ["12", "12", "13"], models, gate: "majority" });
  assert.equal(maj.verdict, "trusted");
  assert.equal(maj.agreement, 2);
  const split = computeCorrectnessAnnotation({ answers: ["12", "13", "14"], models, gate: "majority" });
  assert.equal(split.verdict, "unknown");
});

test("normalization ignores formatting but not value", () => {
  const a = computeCorrectnessAnnotation({ answers: ["Tokyo", "tokyo.", " TOKYO "], models: ["a", "b", "c"], gate: "unanimous" });
  assert.equal(a.verdict, "trusted");
});

test("fewer than 2 answers or any empty answer => unknown (never synthesized)", () => {
  assert.equal(computeCorrectnessAnnotation({ answers: ["391"], models: ["a"] }).verdict, "unknown");
  assert.equal(computeCorrectnessAnnotation({ answers: ["391", ""], models: ["a", "b"], gate: "majority" }).verdict, "unknown");
  assert.equal(computeCorrectnessAnnotation({ answers: [], models: [] }).verdict, "unknown");
});

test("annotation is advisory and never claims authority words", () => {
  const ann = computeCorrectnessAnnotation({ answers: ["x", "x"], models: ["a", "b"], gate: "unanimous" });
  assert.equal(ann.advisory, true);
  assert.equal(ann.schema, "terrarium-correctness-annotation-v0");
  assert.ok(["trusted", "unknown"].includes(ann.verdict));
  // must NOT reuse provenance authority vocabulary
  assert.notEqual(ann.verdict, "verified");
  assert.notEqual(ann.verdict, "correct");
});

test("applyCorrectnessAnnotation cannot change any authority field", () => {
  const terminal = {
    status: "done", ok: true, exitCode: 0, taskContractStatus: "verified",
    reason: "verified-receipt", taskResultSummary: "391",
  };
  const ann = computeCorrectnessAnnotation({ answers: ["391", "392"], models: ["a", "b"], gate: "unanimous" }); // unknown
  const out = applyCorrectnessAnnotation(terminal, ann);
  // authority verbatim
  assert.equal(out.status, "done");
  assert.equal(out.ok, true);
  assert.equal(out.taskContractStatus, "verified");
  assert.equal(out.reason, "verified-receipt");
  // advisory rides alongside, and even an "unknown" correctness does NOT downgrade authority
  assert.equal(out.correctness.verdict, "unknown");
  assert.equal(out.correctness.advisory, true);
  // original object untouched
  assert.equal(terminal.correctness, undefined);
});

test("a 'trusted' correctness annotation still cannot upgrade a non-verified terminal", () => {
  const inconclusive = { status: "inconclusive", ok: false, taskContractStatus: "missing", reason: "receipt-missing" };
  const trusted = computeCorrectnessAnnotation({ answers: ["5", "5", "5"], models: ["a", "b", "c"], gate: "unanimous" });
  const out = applyCorrectnessAnnotation(inconclusive, trusted);
  assert.equal(out.taskContractStatus, "missing"); // unchanged
  assert.equal(out.ok, false);
  assert.equal(out.status, "inconclusive");
  assert.equal(out.correctness.verdict, "trusted"); // advisory only
});

test("applyCorrectnessAnnotation refuses a non-advisory object", () => {
  assert.throws(() => applyCorrectnessAnnotation({ status: "done" }, { verdict: "trusted" }), /advisory/);
});
