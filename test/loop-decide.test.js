import test from "node:test";
import assert from "node:assert/strict";
import { decideNext, gateAttempt, replay, validateContract } from "../src/cloud/loop-decide.js";

const contract = { goal: "multiply", task: "What is 17*23? Reply with just the number.", expect: "391", maxAttempts: 3 };
const pass = { status: "done", verified: true, logs: "TASK_RECEIVED\n391\nTASK_ENDED" };
const wrong = { status: "done", verified: true, logs: "TASK_RECEIVED\n401\nTASK_ENDED" };
const unverified = { status: "done", verified: false, logs: "391" };
const failed = { status: "failed", verified: false, logs: "" };

test("validateContract refuses a contract without an exact expected answer", () => {
  const result = validateContract({ goal: "g", task: "t" });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.startsWith("expect is required")));
  assert.equal(validateContract({ ...contract, maxAttempts: 9 }).ok, false);
  assert.equal(validateContract(contract).ok, true);
});

test("gateAttempt ignores harness lines so a receipt echo cannot pass the gate", () => {
  assert.equal(gateAttempt(contract, pass).passed, true);
  assert.equal(gateAttempt(contract, wrong).passed, false);
  assert.equal(gateAttempt(contract, unverified).passed, false);
  assert.equal(gateAttempt(contract, failed).passed, false);
  const echoOnly = { status: "done", verified: true, logs: 'TERRARIUM_RESULT={"summary":"391"}' };
  assert.equal(gateAttempt(contract, echoOnly).passed, false);
});

test("decideNext stops on the first passing attempt and on exhaustion", () => {
  assert.deepEqual(decideNext(contract, []), { action: "spawn", attempt: 1 });
  assert.equal(decideNext(contract, [{ gate: { passed: true } }]).outcome, "passed");
  const three = [1, 2, 3].map(() => ({ gate: { passed: false } }));
  assert.equal(decideNext(contract, three).outcome, "exhausted");
});

test("replay of the same recorded attempts gives the same decisions every time", () => {
  const recorded = [failed, wrong, pass];
  const first = replay(contract, recorded);
  const second = replay(contract, structuredClone(recorded));
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((d) => d.action), ["spawn", "spawn", "spawn", "stop"]);
  assert.equal(first.at(-1).outcome, "passed");
  assert.equal(replay(contract, [wrong, wrong, wrong]).at(-1).outcome, "exhausted");
});
