import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Cause, Effect, Exit, Layer } from "effect";

import * as store from "../src/owner-store.ts";
import type { Sql, SqlValue } from "../src/owner-store.ts";
import { Callbacks, CallbacksLive, OwnerStores, RunLimits, RunWorkflows, RunsLive } from "../src/runs.ts";
import type { OwnerStore, RunParams } from "../src/runs.ts";
import { Clock, Ids, Owner, Runs } from "../src/shared.ts";
import type { RunTerminal } from "../src/shared.ts";

interface Harness {
  readonly run: <A, E>(ownerId: string, effect: Effect.Effect<A, E, Runs | Callbacks | Owner>) => Promise<Exit.Exit<A, E>>;
  readonly started: Array<RunParams>;
  readonly stopped: Array<string>;
  readonly finish: (ownerId: string, runId: string, terminal: RunTerminal) => Promise<void>;
  readonly advance: (ms: number) => void;
}

const sqlite = (): Sql => {
  const db = new DatabaseSync(":memory:");

  return { rows: (query: string, ...bindings: ReadonlyArray<SqlValue>) => db.prepare(query).all(...bindings) };
};

const storeOver = (sql: Sql): OwnerStore => ({
  admitReserve: (reservation) => store.admitReserve(sql, reservation),
  get: (runId) => store.getRun(sql, runId),
  finish: (runId, terminal, logs) => store.finish(sql, runId, terminal, logs),
  list: (channel, limit) => store.listRuns(sql, channel, limit),
  claim: (request) => store.claim(sql, request),
  ack: (subscriberId, eventId) => store.ack(sql, subscriberId, eventId),
});

const harness = (limits = { maxLive: 8, perMinute: 30, leaseMs: 1000 }): Harness => {
  const owners = new Map<string, OwnerStore>();

  const forOwner = (ownerId: string): OwnerStore => {
    const existing = owners.get(ownerId);

    if (existing !== undefined) return existing;

    const sql = sqlite();
    store.migrate(sql);
    const created = storeOver(sql);
    owners.set(ownerId, created);

    return created;
  };

  const started: Array<RunParams> = [];
  const stopped: Array<string> = [];
  let nowMs = Date.parse("2026-01-01T00:00:00Z");
  let counter = 0;
  const next = () => (counter += 1).toString(16).padStart(12, "0");

  const services = Layer.mergeAll(
    Layer.succeed(OwnerStores, OwnerStores.of({ forOwner })),
    Layer.succeed(RunWorkflows, RunWorkflows.of({
      start: (params) => Effect.sync(() => void started.push(params)),
      stop: (runId) => Effect.sync(() => void stopped.push(runId)),
    })),
    Layer.succeed(Clock, Clock.of({ nowMs: Effect.sync(() => nowMs) })),
    Layer.succeed(Ids, Ids.of({ runId: Effect.sync(() => `ter_abcdef_${next()}`), loopId: Effect.succeed("loop_abcdefgh"), nonce: Effect.sync(() => `nonce-${next()}`) })),
    Layer.succeed(RunLimits, limits),
  );

  const live = Layer.mergeAll(RunsLive, CallbacksLive).pipe(Layer.provideMerge(services));

  return {
    started,
    stopped,
    run: (ownerId, effect) => Effect.runPromiseExit(effect.pipe(Effect.provide(live), Effect.provideService(Owner, Owner.of({ id: ownerId, method: "bearer", email: null })))),
    finish: (ownerId, runId, terminal) => Effect.runPromise(Effect.orDie(forOwner(ownerId).finish(runId, terminal, "log"))).then(() => undefined),
    advance: (ms) => {
      nowMs += ms;
    },
  };
};

const admit = (task: string, idempotencyKey = `key-${task}-0000`) => Effect.flatMap(Runs, (runs) => runs.admit({ task, channel: null, idempotencyKey }));

const getRun = (runId: string) => Effect.flatMap(Runs, (runs) => runs.get(runId));

const cancel = (runId: string) => Effect.flatMap(Runs, (runs) => runs.cancel(runId));

const claim = (subscriberId: string) => Effect.flatMap(Callbacks, (callbacks) => callbacks.claim(subscriberId, 10));

const ack = (subscriberId: string, eventId: string) => Effect.flatMap(Callbacks, (callbacks) => callbacks.ack(subscriberId, eventId));

const done: RunTerminal = { status: "done", contractStatus: "verified", summary: "ok", exitCode: 0, finishedAt: "2026-01-01T00:00:01.000Z" };

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  assert.ok(Exit.isSuccess(exit), `expected success, got ${String(exit)}`);

  return exit.value;
};

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string => (Exit.isFailure(exit) ? JSON.stringify(Cause.prettyErrors(exit.cause).map((error) => [error.name, error.message, { ...error }])) : "success");

test("same idempotency key and body returns the same run and starts one workflow", async () => {
  const h = harness();
  const first = value(await h.run("alice", admit("t1")));
  const second = value(await h.run("alice", admit("t1")));
  assert.equal(second.runId, first.runId);
  assert.equal(h.started.length, 1);
  assert.deepEqual(h.started[0].contract, first.contract);
});

test("same idempotency key with a different body is Conflict", async () => {
  const h = harness();
  value(await h.run("alice", admit("t1", "shared-key-1")));
  assert.match(failureTag(await h.run("alice", admit("t2", "shared-key-1"))), /Conflict/);
});

test("live run limit is RateLimited until a run finishes", async () => {
  const h = harness({ maxLive: 1, perMinute: 30, leaseMs: 1000 });
  const first = value(await h.run("alice", admit("t1")));
  assert.match(failureTag(await h.run("alice", admit("t2"))), /RateLimited.*live/s);
  await h.finish("alice", first.runId, done);
  value(await h.run("alice", admit("t2")));
});

test("per-minute admission limit is RateLimited and resets after a minute", async () => {
  const h = harness({ maxLive: 8, perMinute: 2, leaseMs: 1000 });
  value(await h.run("alice", admit("t1")));
  value(await h.run("alice", admit("t2")));
  assert.match(failureTag(await h.run("alice", admit("t3"))), /RateLimited.*minute/s);
  h.advance(61_000);
  value(await h.run("alice", admit("t3")));
});

test("another owner's run is NotFound for status and cancel, and absent from list", async () => {
  const h = harness();
  const run = value(await h.run("alice", admit("t1")));
  assert.match(failureTag(await h.run("bob", getRun(run.runId))), /NotFound/);
  assert.match(failureTag(await h.run("bob", cancel(run.runId))), /NotFound/);
  assert.deepEqual(value(await h.run("bob", Effect.flatMap(Runs, (runs) => runs.list(null, 10)))), []);
  assert.equal(value(await h.run("alice", Effect.flatMap(Runs, (runs) => runs.list(null, 10)))).length, 1);
});

test("terminal status never changes once recorded", async () => {
  const h = harness();
  const run = value(await h.run("alice", admit("t1")));
  await h.finish("alice", run.runId, done);
  await h.finish("alice", run.runId, { ...done, status: "failed", contractStatus: "missing" });
  assert.equal(value(await h.run("alice", getRun(run.runId))).terminal?.status, "done");
});

test("cancel stops the workflow once, and cancel of a terminal run is a no-op returning the record", async () => {
  const h = harness();
  const run = value(await h.run("alice", admit("t1")));
  assert.equal(value(await h.run("alice", cancel(run.runId))).terminal?.status, "cancelled");
  assert.equal(value(await h.run("alice", cancel(run.runId))).terminal?.status, "cancelled");
  assert.deepEqual(h.stopped, [run.runId]);
});

test("a terminal run emits exactly one callback event", async () => {
  const h = harness();
  const run = value(await h.run("alice", admit("t1")));
  await h.finish("alice", run.runId, done);
  await h.finish("alice", run.runId, done);
  const events = value(await h.run("alice", claim("sub")));
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, run.runId);
  value(await h.run("alice", ack("sub", events[0].eventId)));
  h.advance(5000);
  assert.deepEqual(value(await h.run("alice", claim("sub"))), []);
});

test("a claimed but unacked event is redelivered only after the lease expires", async () => {
  const h = harness();
  const run = value(await h.run("alice", admit("t1")));
  await h.finish("alice", run.runId, done);
  assert.equal(value(await h.run("alice", claim("sub"))).length, 1);
  assert.deepEqual(value(await h.run("alice", claim("sub"))), []);
  h.advance(1001);
  assert.equal(value(await h.run("alice", claim("sub"))).length, 1);
});

test("a malformed ack does not count as delivery", async () => {
  const h = harness();
  const run = value(await h.run("alice", admit("t1")));
  await h.finish("alice", run.runId, done);
  const [event] = value(await h.run("alice", claim("sub")));
  assert.match(failureTag(await h.run("alice", ack("sub", "garbage"))), /BadRequest/);
  assert.match(failureTag(await h.run("alice", ack("", event.eventId))), /BadRequest/);
  h.advance(1001);
  assert.equal(value(await h.run("alice", claim("sub"))).length, 1);
});

test("one owner can never claim or ack another owner's events", async () => {
  const h = harness();
  const run = value(await h.run("alice", admit("t1")));
  await h.finish("alice", run.runId, done);
  assert.deepEqual(value(await h.run("bob", claim("sub"))), []);
  assert.match(failureTag(await h.run("bob", ack("sub", `evt_${run.runId}`))), /NotFound/);
  assert.equal(value(await h.run("alice", claim("sub"))).length, 1);
});
