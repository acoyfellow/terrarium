// Gate 5 slice — deterministic tests for the production model-catalog module.
// Mirrors experiments/model-routing-ax/model-catalog.test.mjs against the
// real src/cloud/model-catalog.js, plus slice-integration proofs:
//  - the Workers AI seed preserves the current server-owned default
//  - GET /api/models is auth-gated and secret-safe
// No network, no live inference, no secrets.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceRegistry, effectiveSources, effectiveCatalog, resolveSelection,
  classifyMiss, classifyProviderOutcome, safeReceiptFields,
} from "../src/cloud/model-catalog.js";
import { _testables } from "../src/cloud/terrarium-sandbox.js";
import { handleApiRuns } from "../src/cloud/api-runs.js";

function req(path, { method = "GET", headers = {} } = {}) {
  return new Request(`https://terrarium.coey.dev${path}`, { method, headers });
}
// Minimal authed env matching principal-auth expectations.
const AUTH_ENV = {
  TERRARIUM_PRINCIPAL_ID: "test-principal",
  TERRARIUM_CONTROL_TOKEN_CURRENT: "x".repeat(40),
};
const AUTH_HEADER = { authorization: `Bearer ${"x".repeat(40)}` };

// ---- seed preserves current server-owned default (byte-identical) ----
test("Workers AI seed default alias maps to the same upstream as resolveServerModel", () => {
  const { defaultUpstream } = buildSourceRegistry({});
  // resolveServerModel with empty env returns the fixed default llama.
  assert.equal(defaultUpstream, _testables.resolveServerModel({}));
});

test("env-pinned allowlisted model reflects into the default alias", () => {
  const pinned = "@cf/meta/llama-3.1-8b-instruct-fast";
  const { defaultAlias, defaultUpstream } = buildSourceRegistry({ TERRARIUM_WORKERS_AI_MODEL: pinned });
  assert.equal(defaultUpstream, pinned);
  assert.equal(defaultAlias, "workers-ai/llama-3.1-8b-fast");
  // and resolveServerModel agrees the pin is allowlisted
  assert.equal(_testables.resolveServerModel({ TERRARIUM_WORKERS_AI_MODEL: pinned }), pinned);
});

test("catalog upstream models exactly cover the existing ALLOWED_WORKERS_AI_MODELS set", () => {
  const { sources } = buildSourceRegistry({});
  const catalogUpstream = new Set(sources["workers-ai"].models.map((m) => m.upstreamModel));
  const allowed = new Set(_testables.ALLOWED_WORKERS_AI_MODELS);
  assert.deepEqual([...catalogUpstream].sort(), [...allowed].sort());
});

// ---- policy engine (mirror of experiment proof) ----
test("effectiveCatalog omits unauthorized custom sources (no existence disclosure)", () => {
  const sources = {
    "workers-ai": { adapter: "openai-compatible", binding: "AI", models: [{ alias: "workers-ai/a", upstreamModel: "u", capabilities: {} }] },
    "priv": { adapter: "openai-compatible", binding: "P", models: [{ alias: "priv/x", upstreamModel: "s", capabilities: {} }], policy: { allowPrincipals: ["boss"] } },
  };
  const cat = effectiveCatalog(sources, { principal: "nobody" });
  assert.deepEqual(cat.map((s) => s.sourceId), ["workers-ai"]);
  const miss = classifyMiss("priv/x", sources, cat);
  assert.equal(miss.decision, "denied");
  assert.equal(miss.http, 403);
});

test("scope intersection never widens", () => {
  const sources = {
    "workers-ai": { adapter: "openai-compatible", binding: "AI", models: [] },
    "priv": { adapter: "openai-compatible", binding: "P", models: [] },
  };
  const widened = effectiveSources(sources, {
    principal: "p",
    workspace: { allowSources: ["workers-ai"] },
    run: { allowSources: ["workers-ai", "priv"] },
  });
  assert.deepEqual(widened, ["workers-ai"]);
});

test("unknown pin -> 400, ambiguous -> 400, no-pin -> default", () => {
  const { sources, defaultAlias } = buildSourceRegistry({});
  const cat = effectiveCatalog(sources, { principal: "p" });
  assert.equal(resolveSelection(null, cat, { defaultAlias }).decision, "default");
  assert.equal(resolveSelection("workers-ai/nope", cat, { defaultAlias }).http, 400);
  assert.equal(resolveSelection("workers-ai/llama-3.3-70b", cat, { defaultAlias }).decision, "allowed");
});

test("3021 backpressure: rate-limited, non-retryable, no fan-out; distinct from 5xx/output", () => {
  const bp = classifyProviderOutcome({ code: 3021 });
  assert.equal(bp.class, "rate-limited");
  assert.equal(bp.retryable, false);
  assert.equal(bp.fanOutAllowed, false);
  assert.equal(classifyProviderOutcome({ status: 503 }).retryable, true);
  assert.equal(classifyProviderOutcome({ kind: "output-error" }).class, "output-error");
});

test("safeReceiptFields never leak secrets/upstream/endpoint", () => {
  const { sources } = buildSourceRegistry({});
  const cat = effectiveCatalog(sources, { principal: "p" });
  const r = resolveSelection("workers-ai/llama-3.3-70b", cat, {});
  const json = JSON.stringify(safeReceiptFields(r));
  assert.equal(/@cf\/|upstreamModel|Bearer|apiKey|endpoint/.test(json), false);
});

// ---- GET /api/models integration: auth-gated + secret-safe ----
test("GET /api/models requires auth (401 without a token)", async () => {
  const res = await handleApiRuns(req("/api/models"), AUTH_ENV);
  assert.equal(res.status, 401);
});

test("GET /api/models returns opaque catalog for authed principal; no upstream leak", async () => {
  const res = await handleApiRuns(req("/api/models", { headers: AUTH_HEADER }), AUTH_ENV);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.defaultModel, "workers-ai/llama-3.3-70b");
  assert.ok(body.sources.find((s) => s.sourceId === "workers-ai").models.length >= 1);
  const json = JSON.stringify(body);
  assert.equal(/@cf\/|upstreamModel|EXAMPLE_ROUTER|Bearer|apiKey/.test(json), false);
});
