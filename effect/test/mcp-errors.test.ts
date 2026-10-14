import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Layer } from "effect";

import { TerrariumClient, TerrariumClientLive, TokenSource } from "../src/client/http.ts";
import { describeFailure } from "../src/client/mcp.ts";
import { NotFound, Unauthorized, Upstream } from "../src/shared.ts";

const tokens = Layer.succeed(TokenSource, TokenSource.of({ header: Effect.succeed({ name: "authorization", value: "Bearer t" }) }));

const replying = (status: number, body: string) => () => Promise.resolve(new Response(body, { status }));

const listFailure = (status: number, body: string) =>
  Effect.runPromise(Effect.flip(Effect.flatMap(TerrariumClient, (client) => client.list({ limit: 1 })).pipe(Effect.provide(TerrariumClientLive("https://t.example", replying(status, body))), Effect.provide(tokens))));

test("describeFailure names the tag and the detail, not just the tag", () => {
  assert.equal(describeFailure(new Upstream({ service: "terrarium", detail: "502 bad gateway" })), "Upstream from terrarium: 502 bad gateway");
  assert.equal(describeFailure(new Unauthorized({ reason: "401 no token" })), "Unauthorized: 401 no token");
  assert.equal(describeFailure(new NotFound({ what: "/api/runs/x/status (404)" })), "NotFound: /api/runs/x/status (404)");
  assert.equal(describeFailure(new Error("unknown tool nope")), "unknown tool nope");
});

test("a 500 reply surfaces its status and body", async () => {
  const failure = await listFailure(500, "kaboom");

  assert.equal(describeFailure(failure), "Upstream from terrarium: 500 kaboom");
});

test("a 401 reply surfaces its status", async () => {
  assert.equal(describeFailure(await listFailure(401, "expired")), "Unauthorized: 401 expired");
});

test("a reply the client cannot decode names the route, the status and the schema problem", async () => {
  const body = JSON.stringify({ ok: true, runs: [{ runId: "r", channel: null, createdAt: "x", status: "done", terminal: { status: "done", summary: null, exitCode: 0, finishedAt: "x" } }] });
  const text = describeFailure(await listFailure(200, body));

  assert.match(text, /^Upstream from terrarium: GET \/api\/runs\?limit=1 returned 200 with a body this client cannot read: /);
  assert.match(text, /provenance/);
});

