import assert from "node:assert/strict";
import test from "node:test";

import { Schema } from "effect";

import { handleRequest } from "../src/app.ts";
import { fakeEnv, principals } from "./fake-env.ts";

const [alice, bob] = principals;

const call = (env: ReturnType<typeof fakeEnv>, path: string, init: RequestInit = {}) => handleRequest(new Request(`https://t${path}`, init), env);

const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

const Admitted = Schema.Struct({ runId: Schema.String });

const Status = Schema.Struct({ runId: Schema.String, status: Schema.String });

test("/health is 200 without auth", async () => {
  assert.equal((await call(fakeEnv(), "/health")).status, 200);
});

test("/api/runs without credentials is 401", async () => {
  assert.equal((await call(fakeEnv(), "/api/runs")).status, 401);
});

test("a bearer principal admits a run and reads its status; another principal gets 404", async () => {
  const env = fakeEnv();
  const admitted = await call(env, "/api/runs", { method: "POST", headers: bearer(alice.token, { "idempotency-key": "worker-test-key-1" }), body: JSON.stringify({ task: "say hi" }) });
  assert.equal(admitted.status, 202);
  const { runId } = Schema.decodeUnknownSync(Admitted)(await admitted.json());
  assert.equal(env.started.length, 1);
  const status = await call(env, `/api/runs/${runId}/status`, { headers: bearer(alice.token) });
  assert.equal(status.status, 200);
  assert.deepEqual(Schema.decodeUnknownSync(Status)(await status.json()), { runId, status: "running" });
  assert.equal((await call(env, `/api/runs/${runId}/status`, { headers: bearer(bob.token) })).status, 404);
});

test("POST /api/loops with a bad contract is 400", async () => {
  const response = await call(fakeEnv(), "/api/loops", { method: "POST", headers: bearer(alice.token), body: JSON.stringify({ goal: "g", task: "t", expect: "e", maxAttempts: 9 }) });
  assert.equal(response.status, 400);
});
