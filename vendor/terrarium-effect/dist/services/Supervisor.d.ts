import { Effect, Schema } from "effect";
import { ReceiptMalformed, type SpawnFailed, type StoreWriteFailed, type Timeout } from "../domain/errors.js";
import { Proc, type ProcResult } from "./Proc.js";
import { RunStore, type ChildRun } from "./RunStore.js";
export declare const TerminalReceipt: Schema.Struct<{
    readonly runId: Schema.String;
    readonly taskFingerprint: Schema.String;
    readonly nonce: Schema.String;
    readonly summary: Schema.String;
}>;
export type TerminalReceipt = Schema.Schema.Type<typeof TerminalReceipt>;
export interface SupervisionRequest extends ChildRun {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly timeoutMs?: number;
}
export interface SupervisionResult extends ProcResult {
    readonly receipt: TerminalReceipt;
}
type ExecutionError = SpawnFailed | Timeout | ReceiptMalformed;
export declare const supervise: (request: SupervisionRequest) => Effect.Effect<SupervisionResult, import("../domain/errors.js").ClaimConflict | import("../domain/errors.js").InvalidBudget | StoreWriteFailed | ExecutionError, Proc | RunStore>;
export {};
