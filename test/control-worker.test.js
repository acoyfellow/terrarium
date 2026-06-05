import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LAB_POLICY } from "../src/lab.js";
import { HOSTILE_SCENARIOS } from "../src/hostile.js";

test("control worker fixture uses the internal Lab hostile scenario", () => {
  assert.ok(HOSTILE_SCENARIOS["lab-env-canary"]);
  assert.equal(HOSTILE_SCENARIOS["lab-env-canary"].fixtureBody, "return true;");
  assert.equal(DEFAULT_LAB_POLICY.allowIssuePublish, false);
  assert.equal(DEFAULT_LAB_POLICY.allowFixPr, false);
  assert.equal(DEFAULT_LAB_POLICY.allowAutoMerge, false);
});

test("control worker remains fixture-only and starts with bounded policy", () => {
  assert.equal(DEFAULT_LAB_POLICY.maxPayloadBytes, 4096);
  assert.equal(DEFAULT_LAB_POLICY.requireFreshReplay, true);
  assert.deepEqual(DEFAULT_LAB_POLICY.allowCapabilities, []);
});
