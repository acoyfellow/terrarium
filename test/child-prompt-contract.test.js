import test from "node:test";
import assert from "node:assert/strict";
import { childPrompt } from "../src/core.js";

const taskContract = { runId: "ter_20260728_abc", taskFingerprint: "fp123", nonce: "nonce-xyz" };

for (const profile of ["default", "minimal"]) {
  test(`${profile} profile makes the receipt the final instruction after the task`, () => {
    const prompt = childPrompt("UNIQUE_TASK_MARKER", { profile, taskContract, runId: taskContract.runId });
    assert.match(prompt.trimEnd(), /TERRARIUM_RESULT= line above as your last line\.$/);
    assert.ok(prompt.lastIndexOf("TERRARIUM_RESULT=") > prompt.indexOf("UNIQUE_TASK_MARKER"));
  });

  test(`${profile} profile still carries exactly one full receipt template`, () => {
    const prompt = childPrompt("task", { profile, taskContract, runId: taskContract.runId });
    assert.equal((prompt.match(/TERRARIUM_RESULT=\{/g) ?? []).length, 1);
  });

  test(`${profile} profile emits no receipt line without a contract`, () => {
    const prompt = childPrompt("task", { profile });
    assert.ok(!prompt.includes("TERRARIUM_RESULT"));
  });

  test(`${profile} profile carries the exact contract correlation values`, () => {
    const prompt = childPrompt("task", { profile, taskContract, runId: taskContract.runId });
    for (const value of [taskContract.runId, taskContract.taskFingerprint, taskContract.nonce]) {
      assert.ok(prompt.includes(value), `missing ${value}`);
    }
  });
}
