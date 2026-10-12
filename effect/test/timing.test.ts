import assert from "node:assert/strict";
import { test } from "node:test";

import { timingLine } from "../src/timing.ts";

test("timingLine splits a run into box, wait, agent and tail", () => {
  const line = timingLine({ startMs: 1000, boxReadyMs: 5000, endMs: 20000, runnerOutput: "TERRARIUM_TIMING runner_start_ms=6000 agent_end_ms=19000" });

  assert.equal(line, "TERRARIUM_PHASES box_ms=4000 runner_wait_ms=1000 agent_ms=13000 tail_ms=1000 total_ms=19000");
});

test("timingLine keeps the Worker-side phases when the runner printed nothing", () => {
  assert.equal(timingLine({ startMs: 0, boxReadyMs: 10, endMs: 30, runnerOutput: "" }), "TERRARIUM_PHASES box_ms=10 total_ms=30");
});
