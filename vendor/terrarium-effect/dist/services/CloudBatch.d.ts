import { Effect } from "effect";
import { BatchCancellationFailed, BatchConfigurationInvalid, CloudAdmissionAmbiguous, CloudConfigurationInvalid, CloudHttpFailed, CloudPollingExhausted, CloudReceiptCorrelationFailed, CloudResponseMalformed, CloudTransportFailed } from "../domain/errors.js";
import { type CloudPollingOptions, type CloudRunResult, type CloudSpawnRequest, type CloudTransport } from "./CloudClient.js";
import { type BatchOptions, type BatchResult } from "./Batch.js";
export interface CloudRunContract {
    readonly runId: string;
    readonly taskFingerprint: string;
    readonly nonce: string;
}
export interface CloudBatchRequest extends BatchOptions {
    readonly jobs: ReadonlyArray<CloudSpawnRequest>;
    readonly polling?: CloudPollingOptions;
    readonly timeoutMs?: number;
}
export interface CloudBatchAdmission {
    readonly index: number;
    readonly runId: string;
    readonly contract: CloudRunContract;
    readonly idempotencyKey: string | null;
    readonly body: Readonly<Record<string, unknown>>;
}
export interface CloudBatchRun {
    readonly index: number;
    readonly admission: CloudBatchAdmission;
    readonly result: CloudRunResult;
}
export type CloudBatchJobError = CloudAdmissionAmbiguous | CloudConfigurationInvalid | CloudHttpFailed | CloudPollingExhausted | CloudReceiptCorrelationFailed | CloudResponseMalformed | CloudTransportFailed;
export interface CloudBatchCancellation {
    readonly index: number;
    readonly runId: string;
    readonly status: number;
    readonly body: unknown;
}
export interface CloudBatchCancellationFailure {
    readonly index: number;
    readonly runId: string;
    readonly error: CloudConfigurationInvalid | CloudHttpFailed | CloudTransportFailed;
}
export interface CloudBatchExecution {
    readonly batch: BatchResult<CloudBatchRun, CloudBatchJobError> | null;
    readonly timedOut: boolean;
    readonly admissions: ReadonlyArray<CloudBatchAdmission>;
    readonly cancellations: ReadonlyArray<CloudBatchCancellation>;
    readonly cancellationFailures: ReadonlyArray<CloudBatchCancellationFailure>;
}
export declare const executeCloudBatch: (request: CloudBatchRequest) => Effect.Effect<CloudBatchExecution, BatchCancellationFailed | BatchConfigurationInvalid | CloudConfigurationInvalid, CloudTransport>;
export declare const successfulCloudBatchRuns: (execution: CloudBatchExecution) => ReadonlyArray<CloudBatchRun>;
