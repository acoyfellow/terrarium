import test from "node:test";
import assert from "node:assert/strict";
import { Option, Schema } from "effect";
import { LoopContract, decideNext, hasCheck, gateAttempt, replay, answerText } from "../src/loop-decide.ts";
import type { RecordedAttempt } from "../src/loop-decide.ts";

const contract: LoopContract = { goal: "multiply", task: "What is 17*23? Reply with just the number.", expect: "391", maxAttempts: 3 };

const attempt = (status: RecordedAttempt["status"], fromThisRun: boolean, logs: string): RecordedAttempt => ({ runId: null, status, fromThisRun, logs });

const pass = attempt("done", true, "TASK_RECEIVED\n391\nTASK_ENDED");

const wrong = attempt("done", true, "TASK_RECEIVED\n401\nTASK_ENDED");

const notFromThisRun = attempt("done", false, "391");

const failed = attempt("failed", false, "");

const decode = Schema.decodeUnknownOption(LoopContract);

test("LoopContract accepts expect, proof, or both, and hasCheck rejects neither", () => {
  assert.equal(hasCheck(Option.getOrThrow(decode({ goal: "g", task: "t" }))), false);
  assert.equal(hasCheck(Option.getOrThrow(decode({ goal: "g", task: "t", proof: "npm test" }))), true);
  assert.equal(decode({ ...contract, maxAttempts: 9 })._tag, "None");
  assert.equal(decode(contract)._tag, "Some");
});

test("LoopContract edge cases", () => {
  assert.equal(decode({ ...contract, goal: "   " })._tag, "None");
  assert.equal(decode({ ...contract, task: "\n\t" })._tag, "None");
  assert.equal(decode({ ...contract, expect: " " })._tag, "None");
  assert.equal(decode({ ...contract, maxAttempts: 0 })._tag, "None");
  assert.equal(decode({ ...contract, maxAttempts: 6 })._tag, "None");
  assert.equal(decode({ ...contract, goal: "x".repeat(301) })._tag, "None");
  assert.deepEqual(decode({ goal: " g ", task: "t", expect: "e" }), decode({ goal: "g", task: "t", expect: "e", maxAttempts: 3 }));
});

test("gateAttempt ignores harness lines so a receipt echo cannot pass the gate", () => {
  assert.equal(gateAttempt(contract, pass).passed, true);
  assert.equal(gateAttempt(contract, wrong).passed, false);
  assert.equal(gateAttempt(contract, notFromThisRun).passed, false);
  assert.equal(gateAttempt(contract, failed).passed, false);
  assert.equal(gateAttempt(contract, attempt("done", true, 'TERRARIUM_RESULT={"summary":"391"}')).passed, false);
  assert.equal(gateAttempt(contract, attempt("done", true, "[terrarium:receipt] 391\n  TERRARIUM_RESULT=391")).passed, false);
});

test("answerText of harness-only output is empty", () => {
  assert.equal(answerText("TASK_RECEIVED\nTERRARIUM_RESULT={}\n[terrarium:x] y\nTASK_ENDED").trim(), "");
});

test("decideNext stops on the first passing attempt and on exhaustion", () => {
  assert.deepEqual(decideNext(contract, []), { action: "spawn", attempt: 1 });
  assert.equal(decideNext(contract, [{ gate: { passed: true, reason: "" } }]).action, "stop");
  assert.deepEqual(decideNext(contract, [{ gate: { passed: true, reason: "" } }]), { action: "stop", outcome: "passed", reason: "attempt 1 passed the gate" });
  const three = [1, 2, 3].map(() => ({ gate: { passed: false, reason: "" } }));
  assert.deepEqual(decideNext(contract, three), { action: "stop", outcome: "exhausted", reason: "3 of 3 attempts used, none passed" });
});

test("replay of the same recorded attempts gives the same decisions every time", () => {
  const recorded = [failed, wrong, pass];
  const first = replay(contract, recorded);
  assert.deepEqual(first, replay(contract, structuredClone(recorded)));
  assert.deepEqual(first.map((d) => d.action), ["spawn", "spawn", "spawn", "stop"]);
  assert.deepEqual(first.at(-1), { action: "stop", outcome: "passed", reason: "attempt 3 passed the gate" });
  assert.deepEqual(replay(contract, [wrong, wrong, wrong]).at(-1), { action: "stop", outcome: "exhausted", reason: "3 of 3 attempts used, none passed" });
});

test("the expected text may appear anywhere in the answer, not only at the start", () => {
  const prose = attempt("done", true, "TASK_RECEIVED\nThe answer is 391.\nTASK_ENDED");
  assert.equal(gateAttempt(contract, prose).passed, true);
});

const proofContract: LoopContract = { goal: "fix", task: "make the test pass", proof: "npm test", maxAttempts: 3 };

const withProof = (proofExit: number | null, claim: string): RecordedAttempt => ({ runId: null, status: "done", fromThisRun: true, proofExit, logs: claim });

test("a proof gate fails a confident claim when the proof exits nonzero", () => {
  const gate = gateAttempt(proofContract, withProof(1, "All tests pass. Done."));

  assert.deepEqual(gate, { passed: false, reason: "proof exited 1" });
});

test("a proof gate passes only on proof exit 0", () => {
  assert.equal(gateAttempt(proofContract, withProof(0, "anything")).passed, true);
  assert.equal(gateAttempt(proofContract, withProof(null, "anything")).reason, "proof did not run");
  assert.equal(gateAttempt(proofContract, attempt("done", true, "no proof field")).reason, "proof did not run");
});

test("proof and expect together need both", () => {
  const both: LoopContract = { ...proofContract, expect: "391" };

  assert.equal(gateAttempt(both, withProof(0, "401")).passed, false);
  assert.equal(gateAttempt(both, withProof(0, "391")).passed, true);
  assert.equal(gateAttempt(both, withProof(2, "391")).passed, false);
});

test("with tools on, the answer may live only in the validated receipt summary", () => {
  const toolsOnLogs = 'TASK_RECEIVED\nTERRARIUM_TIMING runner_start_ms=1 agent_end_ms=2\nTASK_ENDED\nTERRARIUM_RESULT={"nonce":"n","summary":"391"}\nTERRARIUM_PHASES box_ms=1';
  const fromThisRun: RecordedAttempt = { runId: null, status: "done", fromThisRun: true, summary: "391", logs: toolsOnLogs };
  const forged: RecordedAttempt = { ...fromThisRun, fromThisRun: false };

  assert.equal(gateAttempt(contract, fromThisRun).passed, true);
  assert.equal(gateAttempt(contract, forged).passed, false);
  assert.equal(gateAttempt(contract, { ...fromThisRun, summary: "401" }).passed, false);
});

test("timing and phase lines never count as the answer", () => {
  assert.equal(answerText("TERRARIUM_TIMING runner_start_ms=391\nTERRARIUM_PHASES total_ms=391"), "");
});
