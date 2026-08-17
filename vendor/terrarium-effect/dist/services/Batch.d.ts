import { Effect, Result } from "effect";
import { BatchCancellationFailed, BatchConfigurationInvalid } from "../domain/errors.js";
import { type SupervisionRequest } from "./Supervisor.js";
export declare const BatchStrategies: readonly ["all", "allSettled", "race", "any", "quorum"];
export type BatchStrategy = (typeof BatchStrategies)[number];
export interface BatchOptions {
    readonly strategy?: BatchStrategy;
    readonly quorum?: number;
    readonly concurrency?: number;
    readonly cancellationTimeoutMs?: number;
}
export interface BatchOutcome<A, E> {
    readonly index: number;
    readonly result: Result.Result<A, E>;
}
export type BatchReason = "all-complete" | "all-settled" | "race-winner" | "any-success" | "any-exhausted" | "quorum-reached" | "quorum-unreached";
export interface BatchResult<A, E> {
    readonly strategy: BatchStrategy;
    readonly reason: BatchReason;
    readonly ok: boolean;
    readonly outcomes: ReadonlyArray<BatchOutcome<A, E>>;
    readonly successCount: number;
    readonly failureCount: number;
    readonly winner?: BatchOutcome<A, E>;
    readonly winners?: ReadonlyArray<BatchOutcome<A, E>>;
}
interface ValidatedBatchOptions {
    readonly strategy: BatchStrategy;
    readonly quorum: number | null;
    readonly concurrency: number;
    readonly cancellationTimeoutMs: number;
}
export declare const validateBatch: (jobCount: number, options?: BatchOptions) => ValidatedBatchOptions | BatchConfigurationInvalid;
export declare const executeBatch: <A, E, R>(jobs: ReadonlyArray<Effect.Effect<A, E, R>>, options?: BatchOptions) => Effect.Effect<BatchResult<A, E>, BatchConfigurationInvalid | BatchCancellationFailed, R>;
export declare const superviseBatch: (requests: ReadonlyArray<SupervisionRequest>, options?: BatchOptions) => Effect.Effect<BatchResult<import("./Supervisor.js").SupervisionResult, import("../domain/errors.js").ClaimConflict | import("../domain/errors.js").InvalidBudget | import("../domain/errors.js").StoreWriteFailed | (import("../domain/errors.js").ReceiptMalformed | import("../domain/errors.js").SpawnFailed | import("../domain/errors.js").Timeout)>, BatchCancellationFailed | BatchConfigurationInvalid, import("./Proc.js").Proc | import("./RunStore.js").RunStore>;
export {};
