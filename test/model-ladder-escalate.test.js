import test from "node:test";
import assert from "node:assert/strict";
import { runWithBoundedRetries } from "../src/mcp.js";

const config = {
  spawnModelCatalog: [
    { model: "cheap", provider: "prov-a", tier: 10 },
    { model: "strong", provider: "prov-b", tier: 20 },
  ],
};

function noop(runId, model) {
  return { runId, model, ok: false, exitCode: 0, taskContractStatus: "missing" };
}
function success(runId, model) {
  return { runId, model, ok: true, exitCode: 0, taskContractStatus: "verified" };
}

test("a no-op on the first rung escalates to the next model and the receipt shows the path", async () => {
  const calls = [];
  const result = await runWithBoundedRetries(
    { task: "t", modelStrategy: { type: "custom", models: ["cheap", "strong"] } },
    0,
    {
      config,
      runOnce: (a) => {
        calls.push(a.model);
        return calls.length === 1 ? noop("r1", a.model) : success("r2", a.model);
      },
    },
  );
  assert.deepEqual(calls, ["cheap", "strong"]);
  assert.equal(result.ok, true);
  assert.equal(result.runId, "r2");
  assert.deepEqual(result.attemptRunIds, ["r1", "r2"]);
  assert.deepEqual(result.ladderPath.map((r) => r.model), ["cheap", "strong"]);
});

test("high-to-low tries the strongest model first", async () => {
  const calls = [];
  await runWithBoundedRetries(
    { task: "t", modelStrategy: { type: "high-to-low" } },
    0,
    { config, runOnce: (a) => { calls.push(a.model); return success("r", a.model); } },
  );
  assert.equal(calls[0], "strong");
});

test("custom strategy walks the explicit model array in order", async () => {
  const calls = [];
  const result = await runWithBoundedRetries(
    { task: "t", modelStrategy: { type: "custom", models: ["m1", "m2", "m3"] } },
    0,
    { config, runOnce: (a) => { calls.push(a.model); return calls.length < 3 ? noop("r" + calls.length, a.model) : success("r3", a.model); } },
  );
  assert.deepEqual(calls, ["m1", "m2", "m3"]);
  assert.equal(result.ok, true);
  assert.equal(result.runId, "r3");
});

test("a real failure (exit != 0) stops the ladder immediately", async () => {
  const calls = [];
  const result = await runWithBoundedRetries(
    { task: "t", modelStrategy: { type: "custom", models: ["cheap", "strong"] } },
    0,
    { config, runOnce: (a) => { calls.push(a.model); return { runId: "r1", model: a.model, ok: false, exitCode: 1, taskContractStatus: "verified" }; } },
  );
  assert.deepEqual(calls, ["cheap"]);
  assert.equal(result.exitCode, 1);
});

test("maxRetries composes with the ladder: per-rung retries before advancing", async () => {
  const calls = [];
  await runWithBoundedRetries(
    { task: "t", modelStrategy: { type: "custom", models: ["cheap", "strong"] } },
    1,
    { config, runOnce: (a) => { calls.push(a.model); return calls.length <= 2 ? noop("r" + calls.length, a.model) : success("r3", a.model); } },
  );
  assert.deepEqual(calls, ["cheap", "cheap", "strong"]);
});

test("with no strategy it retries the single requested model only", async () => {
  const calls = [];
  await runWithBoundedRetries(
    { task: "t", model: "solo" },
    1,
    { config, runOnce: (a) => { calls.push(a.model); return noop("r" + calls.length, a.model); }, statusOf: (runId) => noop(runId, "solo") },
  );
  assert.deepEqual(calls, ["solo", "solo"]);
});
