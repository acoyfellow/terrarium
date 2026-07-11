// Gate B/C — enforcement + backpressure at the broker.
// Proves: a server-validated opaque alias routes to its upstream; unknown/absent
// alias falls back to default (byte-identical); client cannot inject a
// URL/credential/upstream string; 3021 is backpressure (no retry). No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUpstreamForBroker } from "../src/cloud/model-catalog.js";
import { handleWorkersAiEgress, _testables } from "../src/cloud/terrarium-sandbox.js";

const MODEL_URL = "https://terrarium.coey.dev/_terrarium_model/v1/chat/completions";
function egressReq(body) {
  return new Request(MODEL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
// Fake AI binding that records which upstream model it was asked to run.
function fakeAI(record, { fail } = {}) {
  return {
    run: async (model, _input) => {
      record.push(model);
      if (fail) throw fail;
      return { response: "ok", tool_calls: undefined };
    },
  };
}

// ---- pure resolver (enforcement logic) ----
test("resolveUpstreamForBroker: known alias -> its upstream; matched=true", () => {
  const r = resolveUpstreamForBroker("workers-ai/llama-3.1-8b", {});
  assert.equal(r.upstreamModel, "@cf/meta/llama-3.1-8b-instruct");
  assert.equal(r.matched, true);
  assert.equal(r.binding, "AI");
});

test("resolveUpstreamForBroker: absent/unknown alias -> deployment default; matched=false", () => {
  const def = _testables.resolveServerModel({});
  for (const bad of [undefined, "", "workers-ai/nope", "../etc/passwd", "https://evil/x"]) {
    const r = resolveUpstreamForBroker(bad, {});
    assert.equal(r.upstreamModel, def, `alias ${JSON.stringify(bad)} must fall back to default`);
    assert.equal(r.matched, false);
  }
});

// ---- broker enforcement (RED until broker calls the resolver) ----
test("broker routes a pinned in-scope alias to its upstream model", async () => {
  const seen = [];
  const env = { AI: fakeAI(seen) };
  const res = await handleWorkersAiEgress(egressReq({ model: "workers-ai/llama-3.1-8b", messages: [{ role: "user", content: "hi" }] }), env);
  assert.equal(res.status, 200);
  assert.equal(seen[0], "@cf/meta/llama-3.1-8b-instruct");
});

test("broker ignores an unknown alias and uses the default (byte-identical)", async () => {
  const seen = [];
  const env = { AI: fakeAI(seen) };
  await handleWorkersAiEgress(egressReq({ model: "workers-ai/does-not-exist", messages: [{ role: "user", content: "hi" }] }), env);
  assert.equal(seen[0], _testables.resolveServerModel({}));
});

test("broker with NO model field uses the default (unchanged behavior)", async () => {
  const seen = [];
  const env = { AI: fakeAI(seen) };
  await handleWorkersAiEgress(egressReq({ messages: [{ role: "user", content: "hi" }] }), env);
  assert.equal(seen[0], _testables.resolveServerModel({}));
});

test("broker never routes to a client-supplied raw upstream string", async () => {
  const seen = [];
  const env = { AI: fakeAI(seen) };
  // client tries to smuggle a raw Workers AI model id that is NOT an approved alias
  await handleWorkersAiEgress(egressReq({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", messages: [{ role: "user", content: "hi" }] }), env);
  // a raw upstream string is not an alias -> falls back to default, not honored as a pin
  assert.equal(seen[0], _testables.resolveServerModel({}));
});

// ---- 3021 backpressure (Gate C) ----
test("broker treats a 3021 as backpressure: no retry, 429", async () => {
  const seen = [];
  const err = Object.assign(new Error("AiError 3021: model is busy"), { name: "AiError" });
  const env = { AI: fakeAI(seen, { fail: err }) };
  const res = await handleWorkersAiEgress(egressReq({ messages: [{ role: "user", content: "hi" }] }), env);
  assert.equal(res.status, 429);
  assert.equal(seen.length, 1, "3021 must NOT be retried");
});

test("broker still retries a transient 5xx (distinct from 3021)", async () => {
  const seen = [];
  let calls = 0;
  const env = { AI: { run: async (m) => { seen.push(m); calls++; if (calls < 2) throw Object.assign(new Error("temporarily unavailable"), { status: 503 }); return { response: "ok" }; } } };
  const res = await handleWorkersAiEgress(egressReq({ messages: [{ role: "user", content: "hi" }] }), env);
  assert.equal(res.status, 200);
  assert.ok(calls >= 2, "transient 5xx should retry");
});
