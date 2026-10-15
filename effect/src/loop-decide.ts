import { Effect, Schema } from "effect";

import { Usage } from "./usage.ts";

const field = (maxLength: number) => Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));

export const LoopContract = Schema.Struct({
  goal: field(300),
  task: field(8000),
  expect: Schema.optionalKey(field(500)),
  proof: Schema.optionalKey(field(2000)),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })).pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
});

export type LoopContract = typeof LoopContract.Type;

export const hasCheck = (contract: LoopContract): boolean => contract.expect !== undefined || contract.proof !== undefined;

export const AttemptStatus = Schema.Literals(["done", "failed", "cancelled", "timeout"]);

export const RecordedAttempt = Schema.Struct({
  runId: Schema.NullOr(Schema.String),
  status: AttemptStatus,
  fromThisRun: Schema.Boolean,
  proofExit: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  summary: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(Usage),
  logs: Schema.String,
});

export type RecordedAttempt = typeof RecordedAttempt.Type;

export interface Gate {
  readonly passed: boolean;
  readonly reason: string;
}

export interface GatedAttempt {
  readonly gate: Gate;
}

export type Decision =
  | { readonly action: "spawn"; readonly attempt: number }
  | { readonly action: "stop"; readonly outcome: "passed" | "exhausted"; readonly reason: string };

const harnessLine = /^(TASK_RECEIVED|TASK_ENDED|TERRARIUM_RESULT=.*|\[terrarium:[^\]]*\].*)$/;

export const answerText = (logs: string): string =>
  logs.split("\n").filter((line) => !harnessLine.test(line.trim()) && !line.startsWith("TERRARIUM_")).join("\n");

const verifiedAnswer = (attempt: RecordedAttempt): string =>
  [attempt.fromThisRun ? (attempt.summary ?? "") : "", answerText(attempt.logs)].join("\n");

const proofGate = (contract: LoopContract, attempt: RecordedAttempt): Gate | null => {
  if (contract.proof === undefined) return null;

  if (attempt.proofExit === 0) return null;

  return { passed: false, reason: attempt.proofExit === undefined || attempt.proofExit === null ? "proof did not run" : `proof exited ${attempt.proofExit}` };
};

const passReason = (contract: LoopContract): string =>
  [contract.proof === undefined ? null : "proof exited 0", contract.expect === undefined ? null : "contains the expected text"].filter((part) => part !== null).join(" and ");

export const gateAttempt = (contract: LoopContract, attempt: RecordedAttempt): Gate => {
  const failedProof = proofGate(contract, attempt);

  if (failedProof !== null) return failedProof;

  if (attempt.status !== "done") return { passed: false, reason: `run ended ${attempt.status}` };

  if (!attempt.fromThisRun) return { passed: false, reason: "answer did not come from this run" };

  if (contract.expect !== undefined && !verifiedAnswer(attempt).includes(contract.expect)) return { passed: false, reason: "answer does not contain the expected text" };

  return { passed: true, reason: `from this run, ${passReason(contract)}` };
};

export const decideNext = (contract: LoopContract, attempts: ReadonlyArray<GatedAttempt>): Decision => {
  if (attempts.at(-1)?.gate.passed === true) return { action: "stop", outcome: "passed", reason: `attempt ${attempts.length} passed the gate` };

  if (attempts.length >= contract.maxAttempts) return { action: "stop", outcome: "exhausted", reason: `${attempts.length} of ${contract.maxAttempts} attempts used, none passed` };

  return { action: "spawn", attempt: attempts.length + 1 };
};

export const replay = (contract: LoopContract, recorded: ReadonlyArray<RecordedAttempt>): ReadonlyArray<Decision> => {
  const decisions: Array<Decision> = [];
  const seen: Array<GatedAttempt> = [];

  for (;;) {
    const decision = decideNext(contract, seen);
    decisions.push(decision);
    const next = recorded[seen.length];

    if (decision.action === "stop" || next === undefined) return decisions;

    seen.push({ gate: gateAttempt(contract, next) });
  }
};
