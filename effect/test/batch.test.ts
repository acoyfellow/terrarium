import assert from "node:assert/strict";
import test from "node:test";

import { Effect } from "effect";

import { decideBatch, renderReport, runBatch } from "../pi-extension/batch.ts";
import type { BatchCalls } from "../pi-extension/batch.ts";

const fakeCalls = (finals: ReadonlyArray<string>, ticksToFinish: ReadonlyArray<number>) => {
  const polls = new Map<string, number>();
  const cancelled: Array<string> = [];

  const calls: BatchCalls = {
    admit: (_task, index) => Effect.succeed(`ter_${index}`),
    status: (runId) =>
      Effect.sync(() => {
        const index = Number(runId.slice(4));
        const seen = (polls.get(runId) ?? 0) + 1;

        polls.set(runId, seen);

        return cancelled.includes(runId) ? "cancelled" : seen > ticksToFinish[index] ? finals[index] : "running";
      }),
    summary: (runId) => Effect.succeed(`sum ${runId}`),
    cancel: (runId) => Effect.sync(() => void cancelled.push(runId)),
  };

  return { calls, cancelled };
};

test("decideBatch waits for all, or stops at the first pass", () => {
  assert.equal(decideBatch("all", ["done", "running"]), "wait");
  assert.equal(decideBatch("all", ["done", "failed"]), "done");
  assert.equal(decideBatch("first", ["failed", "running"]), "wait");
  assert.equal(decideBatch("first", ["running", "done"]), "done");
  assert.equal(decideBatch("first", ["failed", "failed"]), "done");
});

test("mode all returns every run and counts passes", async () => {
  const { calls, cancelled } = fakeCalls(["done", "failed", "done"], [0, 1, 2]);
  const report = await Effect.runPromise(runBatch({ tasks: ["a", "b", "c"] }, calls, 1));

  assert.deepEqual(report.runs.map((run) => run.status), ["done", "failed", "done"]);
  assert.equal(report.passed, 2);
  assert.equal(report.winner?.runId, "ter_0");
  assert.deepEqual(cancelled, []);
});

test("mode first returns the first pass and cancels the rest", async () => {
  const { calls, cancelled } = fakeCalls(["done", "done", "failed"], [5, 1, 9]);
  const report = await Effect.runPromise(runBatch({ tasks: ["a", "b", "c"], mode: "first" }, calls, 1));

  assert.equal(report.winner?.runId, "ter_1");
  assert.deepEqual([...cancelled].sort(), ["ter_0", "ter_2"]);
  assert.match(renderReport(report), new RegExp("^terrarium_batch first: 1/3 passed"));
});

test("the deadline stops waiting", async () => {
  const { calls } = fakeCalls(["done"], [1_000_000]);
  const report = await Effect.runPromise(runBatch({ tasks: ["a"] }, calls, 1, 20));

  assert.equal(report.runs[0].status, "running");
  assert.equal(report.winner, null);
});
