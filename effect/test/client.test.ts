import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Exit, Layer, Schema } from "effect";

import { TerrariumClient, TerrariumClientLive, TokenSource } from "../src/client/http.ts";
import type { Fetch } from "../src/client/http.ts";

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

const RUN_ID = "ter_abc123_0123456789ab";

const terminal = { status: "done", contractStatus: "verified", summary: "hi", exitCode: 0, finishedAt: "2026-01-01T00:00:00Z" };

const view = { ok: true, runId: RUN_ID, channel: null, createdAt: "2026-01-01T00:00:00Z", status: "done", terminal };

const contract = { goal: "g", task: "t", expect: "e", maxAttempts: 3 };

const loop = { loopId: "loop_abcdefgh", contract, createdAt: "x", status: "complete", output: { ok: true }, error: null };

const harness = (status: number, reply: Schema.Json) => {
  const seen: Array<Seen> = [];

  const fetcher: Fetch = (url, init) => {
    seen.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body?.toString() ?? null });

    return Promise.resolve(new Response(JSON.stringify(reply), { status }));
  };

  const tokens = Layer.succeed(TokenSource, TokenSource.of({ header: Effect.succeed({ name: "cf-access-token", value: "tok" }) }));
  const layer = TerrariumClientLive("https://t.example", fetcher).pipe(Layer.provide(tokens));

  const run = <A, E>(use: (client: typeof TerrariumClient.Service) => Effect.Effect<A, E>) => Effect.runPromiseExit(Effect.flatMap(TerrariumClient, use).pipe(Effect.provide(layer)));

  return { seen, run };
};

const cases: ReadonlyArray<readonly [string, Schema.Json, (client: typeof TerrariumClient.Service) => Effect.Effect<unknown, unknown>, string, string, string | null]> = [
  ["whoami", { ok: true, method: "access-user", owner: "user:a:b.com", email: "a@b.com" }, (client) => client.whoami, "GET", "/api/whoami", null],
  ["spawn", { ok: true, runId: RUN_ID, contract: { runId: RUN_ID, taskFingerprint: "f", nonce: "n" } }, (client) => client.spawn("do it", "c1"), "POST", "/api/runs", JSON.stringify({ task: "do it", channel: "c1" })],
  ["list", { ok: true, runs: [view] }, (client) => client.list({ channel: "c1", status: "done", limit: 5 }), "GET", "/api/runs?channel=c1&status=done&limit=5", null],
  ["status", view, (client) => client.status(RUN_ID), "GET", `/api/runs/${RUN_ID}/status`, null],
  ["logs", { ok: true, runId: RUN_ID, logs: "L" }, (client) => client.logs(RUN_ID), "GET", `/api/runs/${RUN_ID}/logs`, null],
  ["cancel", view, (client) => client.cancel(RUN_ID), "POST", `/api/runs/${RUN_ID}/cancel`, null],
  ["claim", { ok: true, events: [{ eventId: `evt_${RUN_ID}`, runId: RUN_ID, status: "done", contractStatus: "verified", summary: "hi", finishedAt: "x" }] }, (client) => client.claim("pi-1", 10), "POST", "/claim", JSON.stringify({ subscriberId: "pi-1", limit: 10 })],
  ["ack", { ok: true, eventId: "evt_1" }, (client) => client.ack("pi-1", "evt_1"), "POST", "/ack", JSON.stringify({ subscriberId: "pi-1", eventId: "evt_1" })],
  ["startLoop", { loopId: "loop_abcdefgh", contract }, (client) => client.startLoop({ goal: "g", task: "t", expect: "e" }), "POST", "/api/loops", JSON.stringify({ maxAttempts: 3, goal: "g", task: "t", expect: "e" })],
  ["loops", { loops: [loop] }, (client) => client.loops, "GET", "/api/loops", null],
  ["loop", loop, (client) => client.loop("loop_abcdefgh"), "GET", "/api/loops/loop_abcdefgh", null],
];

cases.forEach(([name, reply, use, method, path, body]) => {
  test(`client ${name} sends ${method} ${path} and decodes the reply`, async () => {
    const { seen, run } = harness(200, reply);
    const exit = await run(use);

    assert.ok(Exit.isSuccess(exit), String(exit));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, method);
    assert.equal(seen[0].url, `https://t.example${path}`);
    assert.equal(seen[0].headers.get("cf-access-token"), "tok");
    assert.equal(seen[0].body ?? null, body);
  });
});

test("spawn sends an idempotency-key header", async () => {
  const { seen, run } = harness(202, { runId: RUN_ID, contract: { runId: RUN_ID, taskFingerprint: "f", nonce: "n" } });

  await run((client) => client.spawn("x"));
  assert.match(seen[0].headers.get("idempotency-key") ?? "", /^[A-Za-z0-9-]{8,}$/);
});

test("a 401 surfaces as Unauthorized", async () => {
  const { run } = harness(401, { ok: false, error: "Unauthorized" });
  const exit = await run((client) => client.whoami.pipe(Effect.flip, Effect.map((error) => error._tag)));

  assert.deepEqual(exit, Exit.succeed("Unauthorized"));
});

test("a malformed reply is an Upstream failure", async () => {
  const { run } = harness(200, { nope: true });
  const exit = await run((client) => client.status(RUN_ID).pipe(Effect.flip, Effect.map((error) => error._tag)));

  assert.deepEqual(exit, Exit.succeed("Upstream"));
});
