import assert from "node:assert/strict";
import test from "node:test";

import { Option, Schema } from "effect";

import { LoopContract, hasCheck, metricConflicts } from "../src/loop-decide.ts";
import { baselineOf, isBetter, metricProof, parseMetric, ratchetStep, ratchetTask, reachedTarget } from "../src/metric.ts";
import type { Metric, Ratchet } from "../src/metric.ts";

const lower: Metric = { command: "wc -c < out.txt", direction: "lower" };

test("the metric proof prints a parseable marker", () => {
  assert.equal(metricProof(lower), "value=$( wc -c < out.txt ); echo \"TERRARIUM_METRIC $value\"");
  assert.deepEqual(parseMetric("noise\nTERRARIUM_METRIC 42\n"), Option.some(42));
  assert.deepEqual(parseMetric("TERRARIUM_METRIC -1.5"), Option.some(-1.5));
  assert.deepEqual(parseMetric("TERRARIUM_METRIC abc"), Option.none());
  assert.deepEqual(parseMetric(null), Option.none());
});

test("baseline is the median and noise is the spread", () => {
  assert.deepEqual(baselineOf([10, 12, 11]), { values: [10, 12, 11], median: 11, noise: 2 });
  assert.equal(baselineOf([10, 14]).median, 12);
});

test("a gain must beat the noise and minGain", () => {
  const baseline = baselineOf([100, 102, 101]);

  assert.equal(isBetter(lower, baseline, 101, 100), false);
  assert.equal(isBetter(lower, baseline, 101, 98), true);
  assert.equal(isBetter({ ...lower, minGain: 10 }, baseline, 101, 95), false);
  assert.equal(isBetter({ ...lower, direction: "higher" }, baseline, 101, 104), true);
});

test("the ratchet keeps only real improvements", () => {
  const baseline = baselineOf([100, 100, 100]);
  const start: Ratchet = { best: 100, bestRunId: "seed", steps: [] };
  const worse = ratchetStep(lower, baseline, start, "r1", Option.some(120));
  const none = ratchetStep(lower, baseline, worse, "r2", Option.none());
  const better = ratchetStep(lower, baseline, none, "r3", Option.some(60));

  assert.equal(worse.bestRunId, "seed");
  assert.equal(none.steps.at(-1)?.reason, "metric did not print a number");
  assert.deepEqual([better.best, better.bestRunId], [60, "r3"]);
  assert.deepEqual(better.steps.map((step) => step.accepted), [false, false, true]);
  assert.match(ratchetTask("shrink it", better, lower), new RegExp("Current best: 60"));
});

test("target, and contract rules", () => {
  assert.equal(reachedTarget({ ...lower, target: 50 }, 50), true);
  assert.equal(reachedTarget(lower, 1), false);

  const contract = Schema.decodeUnknownSync(LoopContract)({ goal: "g", task: "t", metric: lower });

  assert.equal(hasCheck(contract), true);
  assert.deepEqual(metricConflicts(contract), []);
  assert.equal(metricConflicts({ ...contract, proof: "true" }).length, 1);
  assert.throws(() => Schema.decodeUnknownSync(LoopContract)({ goal: "g", task: "t", metric: { ...lower, baselineRuns: 1 } }));
});
