import { Schema } from "effect";

export const APPROVAL_EVENT = "approval";

export const pendingKey = (loopId: string) => `approval:${loopId}`;

export const PendingApproval = Schema.Struct({ attempt: Schema.Int, runId: Schema.NullOr(Schema.String), summary: Schema.NullOr(Schema.String), since: Schema.String });

export type PendingApproval = typeof PendingApproval.Type;

export interface ApprovalBoard {
  readonly put: (loopId: string, pending: PendingApproval) => Promise<void>;
  readonly clear: (loopId: string) => Promise<void>;
}

export const DEFAULT_APPROVAL_TIMEOUT = "24 hours";

export const Approval = Schema.Struct({
  verdict: Schema.Literals(["approve", "reject"]),
  by: Schema.String,
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
});

export type Approval = typeof Approval.Type;

export const ApprovalBody = Schema.Struct({
  verdict: Schema.Literals(["approve", "reject"]),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
});

export interface ApprovalOutcome {
  readonly attempt: number;
  readonly runId: string | null;
  readonly approval: Approval | null;
}

export type AfterGate = { readonly action: "stop"; readonly outcome: "passed" | "exhausted"; readonly reason: string } | { readonly action: "retry"; readonly note: string };

export const afterApproval = (approval: Approval | null, attempt: number, maxAttempts: number): AfterGate => {
  if (approval === null) return { action: "stop", outcome: "exhausted", reason: `attempt ${attempt} passed its gate but no one approved it in time` };

  if (approval.verdict === "approve") return { action: "stop", outcome: "passed", reason: `attempt ${attempt} passed its gate and was approved by ${approval.by}` };

  if (attempt >= maxAttempts) return { action: "stop", outcome: "exhausted", reason: `attempt ${attempt} was rejected by ${approval.by}; no attempts left` };

  return { action: "retry", note: approval.note ?? "rejected without a note" };
};

export const rejectedTask = (task: string, attempt: number, note: string): string => [task, "", `This is attempt ${attempt}. The owner reviewed the previous result and rejected it: ${note}`].join("\n");
