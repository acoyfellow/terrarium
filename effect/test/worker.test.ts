import assert from "node:assert/strict";
import test from "node:test";

import { Schema } from "effect";

import { handleRequest } from "../src/app.ts";
import type { ProbeBox } from "../src/egress.ts";
import { fakeEnv, principals } from "./fake-env.ts";

const [alice, bob] = principals;

const probeBox: ProbeBox = { exec: () => Promise.resolve({ stdout: "reach https://example.com/ 520\nreach https://m/_terrarium_model/v1/models 404\npistartms 1200\n", exitCode: 0 }), destroy: () => Promise.resolve() };

const activityLog = [{ at: 1000, kind: "tool" as const, detail: "bash ls" }, { at: 2000, kind: "text" as const, detail: "done" }];

const probeBoxes = { modelHost: "m", fresh: () => probeBox, activity: (_runId: string, afterMs: number) => Promise.resolve(activityLog.filter((event) => event.at > afterMs)), session: (key: string) => ({ turn: (text: string) => Promise.resolve({ box: `box-${key}`, entries: 2, answer: `echo ${text}`, toolCalls: [], userTurns: 1, stop: "stop", error: "", roles: [] }), replaceBox: () => Promise.resolve({ old: `box-${key}`, fresh: `box2-${key}` }), steer: (text: string) => Promise.resolve(text === "idle" ? { steered: false, reason: "no turn is running" } : { steered: true, reason: "queued" }) }) };

const call = (env: ReturnType<typeof fakeEnv>, path: string, init: RequestInit = {}) => handleRequest(new Request(`https://t${path}`, init), env, probeBoxes);

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

test("the egress probe needs a login and reports what the box could reach", async () => {
  assert.equal((await call(fakeEnv(), "/api/egress-probe")).status, 401);
  const report = await call(fakeEnv(), "/api/egress-probe", { headers: bearer(alice.token) });
  assert.equal(report.status, 200);
  assert.deepEqual(Schema.decodeUnknownSync(Schema.Struct({ reachable: Schema.Record(Schema.String, Schema.String), piStartupMs: Schema.Number }))(await report.json()), { reachable: { "https://example.com/": "520", "https://m/_terrarium_model/v1/models": "404" }, piStartupMs: 1200 });
});

const LoopCreated = Schema.Struct({ loopId: Schema.String });

test("a loop can be created, cancelled and deleted by its owner only", async () => {
  const env = fakeEnv();
  const created = await call(env, "/api/loops", { method: "POST", headers: bearer(alice.token), body: JSON.stringify({ goal: "g", task: "t", expect: "e" }) });
  assert.equal(created.status, 202);
  const { loopId } = Schema.decodeUnknownSync(LoopCreated)(await created.json());
  assert.equal((await call(env, `/api/loops/${loopId}/cancel`, { method: "POST", headers: bearer(bob.token) })).status, 404);
  assert.equal((await call(env, `/api/loops/${loopId}/cancel`, { method: "POST", headers: bearer(alice.token) })).status, 200);
  assert.equal((await call(env, `/api/loops/${loopId}`, { method: "DELETE", headers: bearer(alice.token) })).status, 200);
  assert.equal((await call(env, `/api/loops/${loopId}`, { headers: bearer(alice.token) })).status, 404);
});

test("run activity is readable by its owner, filtered by after", async () => {
  const env = fakeEnv();
  const admitted = await call(env, "/api/runs", { method: "POST", headers: bearer(principals[0].token, { "content-type": "application/json", "idempotency-key": "act-key-0001" }), body: JSON.stringify({ task: "t" }) });
  const { runId } = Schema.decodeUnknownSync(Admitted)(await admitted.json());
  const Events = Schema.Struct({ events: Schema.Array(Schema.Struct({ detail: Schema.String })) });
  const all = Schema.decodeUnknownSync(Events)(await (await call(env, `/api/runs/${runId}/activity`, { headers: bearer(principals[0].token) })).json());
  const newer = Schema.decodeUnknownSync(Events)(await (await call(env, `/api/runs/${runId}/activity?after=1500`, { headers: bearer(principals[0].token) })).json());

  assert.equal(all.events.length, 2);
  assert.deepEqual(newer.events.map((event) => event.detail), ["done"]);
});

test("another owner cannot read my run's activity", async () => {
  const env = fakeEnv();
  const admitted = await call(env, "/api/runs", { method: "POST", headers: bearer(principals[0].token, { "content-type": "application/json", "idempotency-key": "act-key-0002" }), body: JSON.stringify({ task: "t" }) });
  const { runId } = Schema.decodeUnknownSync(Admitted)(await admitted.json());

  assert.equal((await call(env, `/api/runs/${runId}/activity`, { headers: bearer(principals[1].token) })).status, 404);
});

test("a session turn is keyed by the caller's owner id", async () => {
  const response = await call(fakeEnv(), "/api/sessions/s1/turn", { method: "POST", headers: bearer(alice.token), body: JSON.stringify({ text: "hi" }) });
  const body = Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Boolean, box: Schema.String, answer: Schema.String }))(await response.json());

  assert.equal(response.status, 200);
  assert.equal(body.box, `box-${alice.id}::s1`);
  assert.equal(body.answer, "echo hi");
});

test("a session rejects a bad name, an empty text and no credentials", async () => {
  assert.equal((await call(fakeEnv(), "/api/sessions/bad.name/turn", { method: "POST", headers: bearer(alice.token), body: JSON.stringify({ text: "hi" }) })).status, 400);
  assert.equal((await call(fakeEnv(), "/api/sessions/s1/turn", { method: "POST", headers: bearer(alice.token), body: JSON.stringify({ text: "" }) })).status, 400);
  assert.equal((await call(fakeEnv(), "/api/sessions/s1/turn", { method: "POST", body: JSON.stringify({ text: "hi" }) })).status, 401);
});

test("replace-box swaps the session's box", async () => {
  const body = Schema.decodeUnknownSync(Schema.Struct({ old: Schema.String, fresh: Schema.String }))(await (await call(fakeEnv(), "/api/sessions/s1/replace-box", { method: "POST", headers: bearer(alice.token) })).json());

  assert.notEqual(body.old, body.fresh);
});

test("steer is 202 while a turn runs and 409 when idle", async () => {
  assert.equal((await call(fakeEnv(), "/api/sessions/s1/steer", { method: "POST", headers: bearer(alice.token), body: JSON.stringify({ text: "also do x" }) })).status, 202);
  assert.equal((await call(fakeEnv(), "/api/sessions/s1/steer", { method: "POST", headers: bearer(alice.token), body: JSON.stringify({ text: "idle" }) })).status, 409);
});
