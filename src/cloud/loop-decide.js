export const LOOP_LIMITS = Object.freeze({ maxAttempts: 5, maxTaskBytes: 8000, maxExpectBytes: 500, maxGoalBytes: 300 });

export function validateContract(input) {
  const contract = {
    goal: typeof input?.goal === "string" ? input.goal.trim() : "",
    task: typeof input?.task === "string" ? input.task.trim() : "",
    expect: typeof input?.expect === "string" ? input.expect.trim() : "",
    maxAttempts: Number.isInteger(input?.maxAttempts) ? input.maxAttempts : 3,
  };
  const problems = [];
  if (!contract.goal) problems.push("goal is required");
  if (!contract.task) problems.push("task is required");
  if (!contract.expect) problems.push("expect is required: the exact text a passing answer contains");
  if (contract.goal.length > LOOP_LIMITS.maxGoalBytes) problems.push("goal is too long");
  if (contract.task.length > LOOP_LIMITS.maxTaskBytes) problems.push("task is too long");
  if (contract.expect.length > LOOP_LIMITS.maxExpectBytes) problems.push("expect is too long");
  if (contract.maxAttempts < 1 || contract.maxAttempts > LOOP_LIMITS.maxAttempts) problems.push(`maxAttempts must be 1..${LOOP_LIMITS.maxAttempts}`);
  return problems.length ? { ok: false, problems } : { ok: true, contract };
}

const HARNESS_LINE = /^(TASK_RECEIVED|TASK_ENDED|TERRARIUM_RESULT=.*|\[terrarium:[^\]]*\].*)$/;

export function answerText(logs) {
  return String(logs ?? "").split("\n").filter((line) => !HARNESS_LINE.test(line.trim())).join("\n");
}

export function gateAttempt(contract, attempt) {
  if (attempt.status !== "done") return { passed: false, reason: `run ended ${attempt.status}` };
  if (!attempt.verified) return { passed: false, reason: "receipt not verified" };
  if (!answerText(attempt.logs).includes(contract.expect)) return { passed: false, reason: "answer does not contain the expected text" };
  return { passed: true, reason: "verified and contains the expected text" };
}

export function decideNext(contract, attempts) {
  const last = attempts.at(-1);
  if (last?.gate?.passed) return { action: "stop", outcome: "passed", reason: `attempt ${attempts.length} passed the gate` };
  if (attempts.length >= contract.maxAttempts) return { action: "stop", outcome: "exhausted", reason: `${attempts.length} of ${contract.maxAttempts} attempts used, none passed` };
  return { action: "spawn", attempt: attempts.length + 1 };
}

export function replay(contract, recordedAttempts) {
  const decisions = [];
  const seen = [];
  for (;;) {
    const decision = decideNext(contract, seen);
    decisions.push(decision);
    if (decision.action === "stop") return decisions;
    const recorded = recordedAttempts[seen.length];
    if (!recorded) return decisions;
    seen.push({ ...recorded, gate: gateAttempt(contract, recorded) });
  }
}
