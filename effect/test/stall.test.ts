import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Exit, Option } from "effect";
import { TestClock } from "effect/testing";

import { isStalled, stallMessage, watchStall } from "../src/stall.ts";

const policy = { windowMs: 180_000, checkEveryMs: 15_000 };

const watchFor = async (activity: (nowMs: number) => number | null, advanceMs: number) =>
  Effect.runPromise(Effect.gen(function* () {
    const clock = { now: 0 };

    const read = Effect.sync(() => activity(clock.now));

    const fiber = yield* Effect.forkChild(watchStall(read, 0, policy));

    for (let ms = 0; ms < advanceMs; ms += policy.checkEveryMs) {
      clock.now = ms + policy.checkEveryMs;
      yield* TestClock.adjust(policy.checkEveryMs);
    }

    const exit = fiber.pollUnsafe();

    return exit !== undefined && Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none();
  }).pipe(Effect.provide(TestClock.layer())));

test("a quiet run is stalled once the window passes", () => {
  assert.equal(isStalled(180_000, 0, null, 180_000), true);
  assert.equal(isStalled(179_999, 0, null, 180_000), false);
});

test("recent model activity keeps a run alive", () => {
  assert.equal(isStalled(300_000, 0, 200_000, 180_000), false);
});

test("the watcher fires after the window with no activity", async () => {
  const outcome = await watchFor(() => null, 200_000);

  assert.equal(Option.isSome(outcome), true);
  assert.equal(Option.getOrThrow(outcome).quietMs, 180_000);
});

test("the watcher stays quiet while the agent keeps calling the model", async () => {
  const outcome = await watchFor((nowMs) => nowMs - 10_000, 600_000);

  assert.equal(Option.isNone(outcome), true);
});

test("the message says how long it was quiet", () => {
  assert.equal(stallMessage({ quietMs: 181_400 }), "terrarium: stopped after 181s with no model activity (no-progress wake)");
});
