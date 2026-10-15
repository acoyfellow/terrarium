import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Effect, Layer } from "effect";

import * as store from "../src/owner-store.ts";
import type { Sql, SqlValue } from "../src/owner-store.ts";
import { Sandbox, onceOnly } from "../src/run-once.ts";
import type { RunParams } from "../src/runs.ts";
import type { RunRecord } from "../src/shared.ts";

const sqlite = (): Sql => {
  const db = new DatabaseSync(":memory:");

  return { rows: (query: string, ...bindings: ReadonlyArray<SqlValue>) => db.prepare(query).all(...bindings) };
};

const contract = { runId: "ter_aaaaaa_0123456789ab", taskFingerprint: "f", nonce: "n" };

const record: RunRecord = { runId: contract.runId, ownerId: "alice", task: "t", channel: null, contract, createdAt: "2026-01-01T00:00:00.000Z", terminal: null, logs: "" };

const params: RunParams = { ownerId: "alice", runId: contract.runId, task: "t", contract };

const setup = () => {
  const sql = sqlite();
  store.migrate(sql);
  Effect.runSync(store.admitReserve(sql, { idempotencyKey: "k", request: "r", record, nowMs: 0, maxLive: 8, perMinute: 30 }));

  const agentStarts = { count: 0 };

  const box = Layer.succeed(Sandbox, Sandbox.of({ run: () => Effect.sync(() => {
    agentStarts.count += 1;

    return { output: "TASK_ENDED", exitCode: 0, proof: null };
  }) }));

  const owner = { beginStart: (runId: string, nowMs: number) => store.beginStart(sql, runId, nowMs) };

  const step = () => Effect.runPromise(onceOnly(owner, params).pipe(Effect.provide(box)));

  return { sql, agentStarts, step };
};

test("the first start runs the agent", async () => {
  const { agentStarts, step } = setup();
  await step();

  assert.equal(agentStarts.count, 1);
});

test("a replayed run step never starts the agent a second time", async () => {
  const { agentStarts, step } = setup();
  await step();

  const replay = await step();

  assert.equal(agentStarts.count, 1);
  assert.equal(replay.terminal.status, "failed");
  assert.match(replay.logs, /start attempt 2 was refused/);
});

test("the refused attempts are visible on the run", async () => {
  const { sql, step } = setup();
  await step();
  await step();
  await step();

  assert.equal(Effect.runSync(store.getRun(sql, contract.runId)).startAttempts, 3);
});

test("a run that never started has no start count", () => {
  const { sql } = setup();

  assert.equal(Effect.runSync(store.getRun(sql, contract.runId)).startAttempts, undefined);
});

test("a start for an unknown run is refused", () => {
  const { sql } = setup();

  assert.equal(Effect.runSync(Effect.result(store.beginStart(sql, "ter_zzzzzz_0123456789ab", 0)))._tag, "Failure");
});
