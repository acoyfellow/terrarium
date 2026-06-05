import test from "node:test";
import assert from "node:assert/strict";
import { HOSTILE_SCENARIOS, resolveHostileScenario, runHostileLabScenario } from "../src/hostile.js";

test("hostile scenario registry is explicit", () => {
  assert.deepEqual(Object.keys(HOSTILE_SCENARIOS), ["lab-env-canary"]);
  assert.match(resolveHostileScenario("lab-env-canary").description, /forbidden/);
  assert.throws(() => resolveHostileScenario("nope"), /unknown hostile scenario/);
});

test("hostile Lab scenario stays contained when Lab returns false", async () => {
  const receipt = await runHostileLabScenario({
    scenarioId: "lab-env-canary",
    baseUrl: "https://lab.example",
    fetcher: async () => ({ ok: true, json: async () => ({ ok: true, result: false, resultId: "r1" }) }),
  });
  assert.equal(receipt.verdict, "contained");
  assert.equal(receipt.replay, null);
});

test("hostile Lab fixture replay becomes verified escape", async () => {
  let count = 0;
  const receipt = await runHostileLabScenario({
    scenarioId: "lab-env-canary",
    fixture: true,
    baseUrl: "https://lab.example",
    fetcher: async () => ({ ok: true, json: async () => ({ ok: true, result: true, resultId: `r${++count}` }) }),
  });
  assert.equal(receipt.verdict, "escaped");
  assert.equal(receipt.verifiedVerdict, "verified-escape");
  assert.equal(receipt.execution.resultId, "r1");
  assert.equal(receipt.replay.resultId, "r2");
});
