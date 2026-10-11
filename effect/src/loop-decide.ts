import { Effect, Schema } from "effect";

const field = (maxLength: number) => Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));

export const LoopContract = Schema.Struct({
  goal: field(300),
  task: field(8000),
  expect: field(500),
  maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })).pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
});

export type LoopContract = typeof LoopContract.Type;

export const AttemptStatus = Schema.Literals(["done", "failed", "cancelled", "timeout"]);

export const RecordedAttempt = Schema.Struct({
  runId: Schema.NullOr(Schema.String),
  status: AttemptStatus,
  verified: Schema.Boolean,
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
  logs.split("\n").filter((line) => !harnessLine.test(line.trim())).join("\n");

export const gateAttempt = (contract: LoopContract, attempt: RecordedAttempt): Gate => {
  if (attempt.status !== "done") return { passed: false, reason: `run ended ${attempt.status}` };

  if (!attempt.verified) return { passed: false, reason: "receipt not verified" };

  if (!answerText(attempt.logs).includes(contract.expect)) return { passed: false, reason: "answer does not contain the expected text" };

  return { passed: true, reason: "verified and contains the expected text" };
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
