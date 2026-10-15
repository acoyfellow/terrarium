import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import { CloudError } from "../pi-extension/cloud.ts";
import type { CallbackEvent } from "../pi-extension/cloud.ts";
import { watchRun } from "../pi-extension/watch.ts";

const event: CallbackEvent = { eventId: "evt_r", runId: "r", status: "done", provenance: "this-run", summary: "ok" };

const policy = { pollMs: 15_000, maxPolls: 4, maxConsecutiveFailures: 2 };

const counting = (answers: ReadonlyArray<"pending" | "done" | "fail">) => {
  const calls = { count: 0 };

  const probe = Effect.suspend(() => {
    const answer = answers[Math.min(calls.count, answers.length - 1)];
    calls.count += 1;

    if (answer === "fail") return Effect.fail(new CloudError({ detail: "x" }));

    return Effect.succeed(answer === "done" ? Option.some(event) : Option.none<CallbackEvent>());
  });

  return { calls, probe };
};

const runWithClock = <A>(program: Effect.Effect<A>, advanceMs: number) =>
  Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(program);
    yield* TestClock.adjust(advanceMs);

    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));

test("a finished run is delivered after one poll interval", async () => {
  const { calls, probe } = counting(["done"]);
  const outcome = await runWithClock(watchRun(probe, policy), 15_000);

  assert.deepEqual(outcome, { kind: "finished", event });
  assert.equal(calls.count, 1);
});

test("watching stops after the poll cap instead of polling forever", async () => {
  const { calls, probe } = counting(["pending"]);
  const outcome = await runWithClock(watchRun(probe, policy), 15_000 * 10);

  assert.equal(outcome.kind, "gave-up");
  assert.equal(calls.count, 4);
});

test("watching stops after repeated failures", async () => {
  const { calls, probe } = counting(["fail"]);
  const outcome = await runWithClock(watchRun(probe, policy), 15_000 * 10);

  assert.deepEqual(outcome, { kind: "gave-up", reason: "2 failed polls in a row" });
  assert.equal(calls.count, 2);
});

test("a failure followed by success still delivers", async () => {
  const { probe } = counting(["fail", "pending", "done"]);

  assert.equal((await runWithClock(watchRun(probe, policy), 15_000 * 3)).kind, "finished");
});
