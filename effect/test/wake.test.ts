import assert from "node:assert/strict";
import test from "node:test";

import { Option, Schema } from "effect";

import { LoopContract, hasCheck } from "../src/loop-decide.ts";
import { Wake, durationMs, hookSignature, nextTask, sameText } from "../src/wake.ts";

const decode = Schema.decodeUnknownOption(Wake);

test("event and timer wakes decode; nonsense does not", () => {
  assert.equal(Option.isSome(decode({ on: "event" })), true);
  assert.equal(Option.isSome(decode({ on: "event", timeout: "2 hours" })), true);
  assert.equal(Option.isSome(decode({ every: "5 minutes" })), true);
  assert.equal(Option.isNone(decode({ every: "soon" })), true);
  assert.equal(Option.isNone(decode({ on: "cron" })), true);
});

test("a loop contract can carry a wake", () => {
  const contract = Schema.decodeUnknownSync(LoopContract)({ goal: "g", task: "t", expect: "x", wake: { on: "event" } });

  assert.deepEqual(contract.wake, { on: "event" });
  assert.equal(hasCheck(contract), true);
});

test("the first attempt gets the task as written", () => {
  assert.equal(nextTask("do it", 1, [], null), "do it");
});

test("later attempts carry what woke them and why the last one failed", () => {
  const task = nextTask("do it", 3, [{ source: "ci", note: "build red: missing semicolon" }, null], "proof exited 1");

  assert.match(task, /attempt 3/);
  assert.match(task, /proof exited 1/);
  assert.match(task, /wake 1 from ci: build red: missing semicolon/);
  assert.match(task, /wake 2: timer/);
});

test("hook signatures are per loop and compared in full", async () => {
  const one = await hookSignature("s3cret", "loop_a");

  assert.match(one, /^[0-9a-f]{64}$/);
  assert.notEqual(one, await hookSignature("s3cret", "loop_b"));
  assert.notEqual(one, await hookSignature("other", "loop_a"));
  assert.equal(sameText(one, one), true);
  assert.equal(sameText(one, `${one.slice(0, -1)}0`), one.endsWith("0"));
  assert.equal(sameText(one, one.slice(1)), false);
});

test("durations convert to milliseconds", () => {
  assert.equal(durationMs("5 minutes"), 300_000);
  assert.equal(durationMs("1 hour"), 3_600_000);
  assert.equal(durationMs("30 seconds"), 30_000);
});
