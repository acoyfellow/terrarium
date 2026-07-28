import test from "node:test";
import assert from "node:assert/strict";
import { buildModelLadder, spawnModelCatalog } from "../src/model-resolution.js";

const config = {
  spawnModelCatalog: [
    { model: "cheap-fast", provider: "prov-a", tier: 10 },
    { model: "mid", provider: "prov-b", tier: 20 },
    { model: "top", provider: "prov-c", tier: 40 },
  ],
};

test("low-to-high orders the catalog cheapest first", () => {
  const ladder = buildModelLadder({ type: "low-to-high" }, { config }).map((r) => r.model);
  assert.ok(ladder.indexOf("cheap-fast") < ladder.indexOf("mid"));
  assert.ok(ladder.indexOf("mid") < ladder.indexOf("top"));
  assert.equal(ladder.at(-1), "top");
  const tiers = buildModelLadder({ type: "low-to-high" }, { config: {} });
  assert.ok(tiers.length > 1, "the built-in catalog must offer more than one rung");
  assert.equal(tiers[0].model, "gemini-2.5-flash-lite");
});

test("low-to-high and high-to-low are exact reverses over tiers", () => {
  const low = buildModelLadder({ type: "low-to-high" }, { config }).map((r) => r.model);
  const high = buildModelLadder({ type: "high-to-low" }, { config }).map((r) => r.model);
  assert.deepEqual(high, [...low].reverse());
});

test("high-to-low puts the highest tier first", () => {
  const ladder = buildModelLadder({ type: "high-to-low" }, { config });
  assert.equal(ladder[0].model, "top");
});

test("custom passes the explicit model array through in order and resolves known providers", () => {
  const ladder = buildModelLadder({ type: "custom", models: ["top", "unknown-x", "cheap-fast"] }, { config });
  assert.deepEqual(ladder.map((r) => r.model), ["top", "unknown-x", "cheap-fast"]);
  assert.equal(ladder[0].provider, "prov-c");
  assert.equal(ladder[1].provider, null);
  assert.equal(ladder[2].provider, "prov-a");
});

test("custom with an empty models array is rejected", () => {
  assert.throws(() => buildModelLadder({ type: "custom", models: [] }, { config }), /non-empty models array/);
});

test("an unknown strategy type is rejected", () => {
  assert.throws(() => buildModelLadder({ type: "sideways" }, { config }), /unknown modelStrategy\.type/);
});

test("no strategy falls back to the single requested model", () => {
  assert.deepEqual(buildModelLadder(undefined, { config, fallbackModel: "solo" }), [{ model: "solo", provider: null }]);
  assert.deepEqual(buildModelLadder(null, { config }), []);
});

test("the built-in catalog always contains the pinned gpt-5.6-terra rung", () => {
  const catalog = spawnModelCatalog();
  const pinned = catalog.find((c) => c.model === "gpt-5.6-terra");
  assert.ok(pinned);
  assert.equal(pinned.provider, "opencode.cloudflare.dev");
});
