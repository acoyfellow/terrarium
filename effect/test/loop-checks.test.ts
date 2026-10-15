import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import { checkResults, checksCommand, scoreLine } from "../src/loop-checks.ts";
import { gateAttempt, hasCheck, runProofOf } from "../src/loop-decide.ts";
import type { LoopContract, RecordedAttempt } from "../src/loop-decide.ts";

const checks = [
  { name: "file exists", command: "test -f a.txt" },
  { name: "says hi", command: "grep -q hi a.txt" },
  { name: "quote's safe", command: "echo 'it''s' > /dev/null" },
];

const shell = (command: string, cwd: string) => {
  const result = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });

  return { exit: result.status, output: result.stdout };
};

const scratch = (content: string | null) => {
  const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();

  if (content !== null) execFileSync("sh", ["-c", `printf '%s' "$1" > a.txt`, "_", content], { cwd: dir });

  return dir;
};

test("the built command reports each check and fails if any fails", () => {
  const run = shell(checksCommand(checks, undefined), scratch("bye"));
  const results = checkResults(checks, undefined, run.output);

  assert.notEqual(run.exit, 0);
  assert.deepEqual(results.map((r) => r.state), ["passed", "failed", "passed"]);
  assert.equal(scoreLine(results), "2✓ 0○ 1✗");
});

test("all checks passing exits 0", () => {
  const run = shell(checksCommand(checks, undefined), scratch("hi"));

  assert.equal(run.exit, 0);
  assert.equal(scoreLine(checkResults(checks, undefined, run.output)), "3✓ 0○ 0✗");
});

test("a proof runs first and its exit is not counted as a named check", () => {
  const run = shell(checksCommand(checks.slice(0, 1), "false"), scratch("hi"));

  assert.notEqual(run.exit, 0);
  assert.deepEqual(checkResults(checks.slice(0, 1), "false", run.output).map((r) => r.state), ["passed"]);
});

test("missing output means checks did not run", () => {
  assert.equal(scoreLine(checkResults(checks, undefined, null)), "0✓ 3○ 0✗");
});

test("a loop with only named checks has a check and a run proof", () => {
  const contract: LoopContract = { goal: "g", task: "t", checks: checks.slice(0, 1), maxAttempts: 1 };

  assert.equal(hasCheck(contract), true);
  assert.match(runProofOf(contract) ?? "", /TERRARIUM_CHECK/);
});

test("the gate names the checks that are not passing", () => {
  const contract: LoopContract = { goal: "g", task: "t", checks, maxAttempts: 1 };
  const attempt: RecordedAttempt = { runId: "r", status: "failed", fromThisRun: true, proofExit: 1, logs: "", checks: [{ name: "file exists", state: "passed" }, { name: "says hi", state: "failed" }, { name: "quote's safe", state: "not-run" }] };

  assert.deepEqual(gateAttempt(contract, attempt), { passed: false, reason: "checks not passing: says hi, quote's safe" });
  assert.equal(gateAttempt(contract, { ...attempt, status: "done", proofExit: 0, checks: [] }).passed, true);
});
