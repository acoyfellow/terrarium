import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Option, Schema } from "effect";

import { DEFAULT_MODEL, modelProblems, priceBasisOf, routeOf } from "../src/models.ts";
import { answerModel, backendFor, gatewayBackend, gatewayOf } from "../src/model-route.ts";
import type { Fetcher, ModelBackend, ModelInput } from "../src/model-route.ts";
import { PRICE_BASIS, ZERO_USAGE, addCall, sumUsage } from "../src/usage.ts";
import { toolRequest } from "../src/remote-mcp.ts";

const GATEWAY = { url: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/", token: "gw-token" };

const HAIKU = "anthropic/claude-haiku-4-5";

test("Workers AI and AI Gateway ids route to their backends", () => {
  assert.deepEqual(routeOf(DEFAULT_MODEL), Option.some({ kind: "workers-ai", id: DEFAULT_MODEL }));
  assert.deepEqual(routeOf("@cf/qwen/qwen2.5-coder-32b-instruct"), Option.some({ kind: "workers-ai", id: "@cf/qwen/qwen2.5-coder-32b-instruct" }));
  assert.deepEqual(routeOf(HAIKU), Option.some({ kind: "gateway", id: HAIKU }));
});

test("anything else is not a model", () => {
  for (const bad of ["", "llama", "https://evil.example/v1", "../../etc", "anthropic/claude haiku", `anthropic/${"x".repeat(200)}`]) {
    assert.equal(Option.isNone(routeOf(bad)), true, bad);
    assert.equal(modelProblems(bad).length, 1, bad);
  }

  assert.deepEqual(modelProblems(null), []);
  assert.deepEqual(modelProblems(undefined), []);
});

test("the default model keeps the old price basis, so old receipts compare", () => {
  assert.equal(PRICE_BASIS, "workers-ai llama-3.3-70b-fp8-fast list price: $0.29/M in, $2.25/M out");
  assert.equal(priceBasisOf(DEFAULT_MODEL), PRICE_BASIS);
});

test("a known model is priced at its own list price", () => {
  const usage = addCall(ZERO_USAGE, { promptTokens: 1_000_000, completionTokens: 1_000_000 }, HAIKU);

  assert.equal(usage.estimatedUsd, 6);
  assert.match(usage.priceBasis, /anthropic\/claude-haiku-4-5 list price: \$1\/M in, \$5\/M out/);
});

test("a model with no list price says so instead of guessing", () => {
  const usage = addCall(ZERO_USAGE, { promptTokens: 1000, completionTokens: 1000 }, "openai/some-new-model");

  assert.equal(usage.estimatedUsd, 0);
  assert.match(usage.priceBasis, /no list price/);
});

test("a loop over two models sums each attempt's own price and lists both bases", () => {
  const llama = addCall(ZERO_USAGE, { promptTokens: 1_000_000, completionTokens: 0 });
  const haiku = addCall(ZERO_USAGE, { promptTokens: 1_000_000, completionTokens: 0 }, HAIKU);
  const sum = sumUsage([llama, haiku]);

  assert.equal(sum.estimatedUsd, 1.29);
  assert.equal(sum.priceBasis.split(" + ").length, 2);
});

const chat = (body: Schema.Json) => new Request("https://model.example/_terrarium_model/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });

const userSays = (content: string): ModelInput => ({ messages: [{ role: "user", content }] });

const ErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });

const CompletionBody = Schema.Struct({ model: Schema.String });

const SentBody = Schema.Struct({ model: Schema.String, stream: Schema.Boolean });

const SpawnBody = Schema.Struct({
  task: Schema.String,
  proof: Schema.NullOr(Schema.String),
  channel: Schema.NullOr(Schema.String),
  model: Schema.optionalKey(Schema.String),
  resumeFrom: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.Struct({ github: Schema.String })),
  plugins: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, source: Schema.String }))),
});

const parsed = <S extends Schema.Decoder<unknown>>(schema: S, message: Request | Response | null) =>
  Effect.runPromise(Effect.promise(() => message?.json() ?? Promise.resolve(null)).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema))));

const reply = { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } };

test("the gateway backend sends the run's model with the gateway token and no box credential", async () => {
  const seen: Array<Request> = [];

  const fetcher: Fetcher = (url, init) => {
    seen.push(new Request(url, init));

    return Promise.resolve(Response.json(reply));
  };

  const answer = await gatewayBackend(GATEWAY, HAIKU, fetcher).run(userSays("hello"));
  const sent = await parsed(SentBody, seen[0]);

  assert.equal(seen[0].url, "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions");
  assert.equal(seen[0].headers.get("cf-aig-authorization"), "Bearer gw-token");
  assert.deepEqual(sent, { model: HAIKU, stream: false });
  assert.equal(answer.answer.content, "hi");
  assert.deepEqual(answer.tokens, Option.some({ promptTokens: 3, completionTokens: 1 }));
});

test("a gateway error reaches the box as a model error with the reason", async () => {
  const fetcher: Fetcher = () => Promise.resolve(new Response("unknown model", { status: 400 }));
  const response = await Effect.runPromise(answerModel(chat({ messages: [{ role: "user", content: "x" }] }), gatewayBackend(GATEWAY, "anthropic/nope", fetcher)));
  const body = await parsed(ErrorBody, response);

  assert.equal(response.status, 502);
  assert.match(body.error.message, /gateway 400: unknown model/);
});

const neverWorkersAi = (id: string): ModelBackend => ({ id, run: () => Promise.reject(new Error("Workers AI must not be called")) });

test("a gateway model without a configured gateway fails loudly, not silently on another model", async () => {
  const backend = backendFor({ kind: "gateway", id: HAIKU }, { workersAi: neverWorkersAi, gateway: null });
  const response = await Effect.runPromise(answerModel(chat({ messages: [{ role: "user", content: "x" }] }), backend));
  const body = await parsed(ErrorBody, response);

  assert.equal(response.status, 502);
  assert.match(body.error.message, /needs AI Gateway/);
});

test("a Workers AI model goes to Workers AI with its own id", () => {
  const backend = backendFor({ kind: "workers-ai", id: "@cf/qwen/qwen2.5-coder-32b-instruct" }, { workersAi: neverWorkersAi, gateway: GATEWAY });

  assert.equal(backend.id, "@cf/qwen/qwen2.5-coder-32b-instruct");
});

test("the model route ignores the model the box asks for and answers as the run's model", async () => {
  const asked: Array<string> = [];

  const backend: ModelBackend = {
    id: HAIKU,
    run: (input) => {
      asked.push(JSON.stringify(input));

      return Promise.resolve({ answer: { content: "ok", toolCalls: [] }, tokens: Option.none() });
    },
  };

  const response = await Effect.runPromise(answerModel(chat({ model: "openai/expensive", messages: [{ role: "user", content: "x" }] }), backend));
  const body = await parsed(CompletionBody, response);

  assert.equal(body.model, HAIKU);
  assert.equal(asked[0].includes("openai/expensive"), false);
});

test("the gateway is configured only by an https url and a token together", () => {
  assert.equal(gatewayOf({}), null);
  assert.equal(gatewayOf({ TERRARIUM_GATEWAY_URL: "https://g.example/compat" }), null);
  assert.equal(gatewayOf({ TERRARIUM_GATEWAY_URL: "http://g.example/compat", TERRARIUM_GATEWAY_TOKEN: "t" }), null);
  assert.deepEqual(gatewayOf({ TERRARIUM_GATEWAY_URL: "https://g.example/compat", TERRARIUM_GATEWAY_TOKEN: "t" }), { url: "https://g.example/compat", token: "t" });
});

test("the remote MCP spawn tool passes model, resumeFrom, repo and plugins through", async () => {
  const request = toolRequest("https://terrarium.example", "terrarium_spawn", { task: "fix it", proof: "npm test", model: HAIKU, resumeFrom: "ter_1", repo: { github: "acoyfellow/gleam-agents" }, plugins: [{ name: "a", source: "x" }] });
  const body = await parsed(SpawnBody, request);

  assert.deepEqual(body, { task: "fix it", proof: "npm test", channel: null, model: HAIKU, resumeFrom: "ter_1", repo: { github: "acoyfellow/gleam-agents" }, plugins: [{ name: "a", source: "x" }] });
});

test("a spawn without the new fields sends the same body as before", async () => {
  const body = await parsed(SpawnBody, toolRequest("https://terrarium.example", "terrarium_spawn", { task: "echo hi" }));

  assert.deepEqual(body, { task: "echo hi", proof: null, channel: null });
});

test("a spawn with a malformed new field is invalid, not silently dropped", () => {
  assert.equal(toolRequest("https://terrarium.example", "terrarium_spawn", { task: "x", repo: "acoyfellow/gleam-agents" }), null);
});
