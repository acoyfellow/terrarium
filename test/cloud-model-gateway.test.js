// Gate D — custom openai-compatible gateway source.
// PLACEHOLDERS ONLY. Proves the generic adapter routes via server-side env
// keys, is auth-scoped, and never exposes endpoint/token/upstream to the
// client, catalog, or receipt. No real gateway values appear anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceRegistry, effectiveCatalog, resolveUpstreamForBroker,
  routeOpenAICompatible, classifyMiss, safeReceiptFields,
} from "../src/cloud/model-catalog.js";

// Server-side deployment config (placeholder). Real values would live in a
// gitignored var; here everything is a public placeholder.
const CUSTOM = JSON.stringify([
  {
    sourceId: "example-router",
    adapter: "openai-compatible",
    endpointEnv: "EXAMPLE_ENDPOINT",
    tokenEnv: "EXAMPLE_TOKEN",
    models: [
      { alias: "example-router/demo", upstreamModel: "placeholder-upstream-model",
        capabilities: { reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192 } },
    ],
    policy: { allowPrincipals: ["operator-authorized"] },
  },
]);
const ENV = {
  TERRARIUM_CUSTOM_SOURCES: CUSTOM,
  EXAMPLE_ENDPOINT: "https://router.example/v1/chat/completions",
  EXAMPLE_TOKEN: "placeholder-secret-token",
};

test("custom source is parsed fail-closed and registered from env only", () => {
  const { sources } = buildSourceRegistry(ENV);
  assert.ok(sources["example-router"]);
  assert.equal(sources["example-router"].adapter, "openai-compatible");
  // malformed / workers-ai-collision / missing envs are rejected
  const bad = buildSourceRegistry({ TERRARIUM_CUSTOM_SOURCES: JSON.stringify([
    { sourceId: "workers-ai", adapter: "openai-compatible", endpointEnv: "E", tokenEnv: "T", models: [{ alias: "x", upstreamModel: "y" }] },
    { sourceId: "no-envs", adapter: "openai-compatible", models: [{ alias: "a", upstreamModel: "b" }] },
    { sourceId: "not-json-adapter", adapter: "evil", endpointEnv: "E", tokenEnv: "T", models: [{ alias: "a", upstreamModel: "b" }] },
  ]) });
  assert.equal(Object.keys(bad.sources).length, 1); // only workers-ai survives
  assert.equal(bad.sources["workers-ai"].adapter, "workers-ai"); // not overwritten
});

test("no TERRARIUM_CUSTOM_SOURCES -> only workers-ai (byte-identical default)", () => {
  const { sources } = buildSourceRegistry({});
  assert.deepEqual(Object.keys(sources), ["workers-ai"]);
});

test("custom source visible only to authorized principal; catalog leaks nothing", () => {
  const { sources } = buildSourceRegistry(ENV);
  const authed = effectiveCatalog(sources, { principal: "operator-authorized" });
  assert.ok(authed.find((s) => s.sourceId === "example-router"));
  const anon = effectiveCatalog(sources, { principal: "nobody" });
  assert.equal(anon.find((s) => s.sourceId === "example-router"), undefined);
  // no endpoint/token/upstream in catalog JSON
  const json = JSON.stringify(authed);
  assert.equal(/router\.example|placeholder-secret-token|placeholder-upstream-model|EXAMPLE_ENDPOINT|EXAMPLE_TOKEN/.test(json), false);
});

test("resolveUpstreamForBroker returns endpoint/token ENV KEYS, not values", () => {
  const r = resolveUpstreamForBroker("example-router/demo", ENV);
  assert.equal(r.matched, true);
  assert.equal(r.adapter, "openai-compatible");
  assert.equal(r.endpointEnv, "EXAMPLE_ENDPOINT");
  assert.equal(r.tokenEnv, "EXAMPLE_TOKEN");
  // the resolved object carries env KEY NAMES, never the secret values
  const json = JSON.stringify(r);
  assert.equal(/router\.example|placeholder-secret-token/.test(json), false);
});

test("routeOpenAICompatible attaches token server-side; client never supplies it", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  const resolved = resolveUpstreamForBroker("example-router/demo", ENV);
  const out = await routeOpenAICompatible(resolved, { messages: [{ role: "user", content: "hi" }] }, ENV, { fetchImpl });
  assert.equal(captured.url, "https://router.example/v1/chat/completions");
  assert.equal(captured.headers.authorization, "Bearer placeholder-secret-token");
  assert.equal(captured.body.model, "placeholder-upstream-model"); // server-side upstream
  assert.ok(out.choices);
});

test("routeOpenAICompatible fails closed when endpoint or token env is missing", async () => {
  const resolved = resolveUpstreamForBroker("example-router/demo", ENV);
  await assert.rejects(() => routeOpenAICompatible(resolved, { messages: [] }, { EXAMPLE_ENDPOINT: "https://router.example/v1" }), /credential unavailable/);
  await assert.rejects(() => routeOpenAICompatible(resolved, { messages: [] }, { EXAMPLE_TOKEN: "t" }), /endpoint unavailable/);
});

test("unauthorized principal cannot pin the custom alias (denied)", () => {
  const { sources } = buildSourceRegistry(ENV);
  const anon = effectiveCatalog(sources, { principal: "nobody" });
  const miss = classifyMiss("example-router/demo", sources, anon);
  assert.equal(miss.decision, "denied");
  assert.equal(miss.http, 403);
});

test("safe receipt fields for a custom-source run carry only opaque alias/source/policy", () => {
  const r = resolveUpstreamForBroker("example-router/demo", ENV);
  const rec = safeReceiptFields({ sourceId: r.sourceId, alias: r.alias, receiptReason: "allowed" });
  const json = JSON.stringify(rec);
  assert.equal(/router\.example|placeholder-secret-token|placeholder-upstream-model/.test(json), false);
  assert.equal(rec.model, "example-router/demo");
});
