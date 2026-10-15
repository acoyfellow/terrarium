import assert from "node:assert/strict";
import test from "node:test";

import { admitBody, handleOf, idempotencyKey, parseOptions } from "../pi-extension/subagent-provider.ts";
import { REGISTRY, registerProvider } from "../pi-extension/subagent-registry.ts";
import type { RegistryHost } from "../pi-extension/subagent-registry.ts";

const input = { prompt: "do it", promptDigest: "d1", runId: "r1", stepIndex: 0, agent: "boxed", options: {} };

test("a start maps to a Terrarium run body with a stable idempotency key", () => {
  assert.deepEqual(admitBody(input), { task: "do it", proof: null, channel: "pi-subagents:boxed" });
  assert.deepEqual(admitBody({ ...input, options: { proof: "npm test", channel: "c" } }), { task: "do it", proof: "npm test", channel: "c" });
  assert.equal(idempotencyKey(input), idempotencyKey({ ...input }));
  assert.notEqual(idempotencyKey(input), idempotencyKey({ ...input, stepIndex: 1 }));
  assert.match(idempotencyKey({ ...input, runId: "a:b c", promptDigest: "sha256:ff" }), new RegExp("^[A-Za-z0-9._~+/=-]{8,255}$"));
});

test("options that are not strings are dropped", () => {
  assert.deepEqual(parseOptions({ proof: "x" }), { proof: "x" });
  assert.deepEqual(parseOptions(JSON.parse("{\"proof\":5}")), {});
});

test("run statuses map to job states", () => {
  const url = "https://t";

  assert.equal(handleOf(url, { runId: "a", terminal: null }).state, "running");
  assert.equal(handleOf(url, { runId: "a", terminal: { status: "done", provenance: "this-run", summary: "ok" } }).state, "completed");
  assert.equal(handleOf(url, { runId: "a", terminal: { status: "cancelled", provenance: "missing", summary: null } }).state, "stopped");

  const failed = handleOf(url, { runId: "a", terminal: { status: "failed", provenance: "missing", summary: null } });

  assert.equal(failed.state, "failed");
  assert.equal(failed.failureCode, "terrarium_missing");
});

test("the provider registers in the shared pi-subagents registry", () => {
  const host: RegistryHost = {};
  const provider = registerProvider("https://t", host);
  const again = registerProvider("https://t", host);
  const registry = host[REGISTRY];

  assert.equal(provider.name, "terrarium");
  assert.equal(registry?.providers.get("terrarium"), again);
  assert.equal(registry?.providers.size, 1);
});
