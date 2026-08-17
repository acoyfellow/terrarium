import { Context, Effect, Layer } from "effect";
import { CloudConfigurationInvalid, CloudHttpFailed, CloudPollingExhausted, CloudResponseMalformed, CloudTransportFailed } from "../domain/errors.js";
export interface CloudHttpRequest {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
}
export interface CloudHttpResponse {
    readonly status: number;
    readonly body: unknown;
}
export interface CloudTransport {
    readonly request: (request: CloudHttpRequest) => Effect.Effect<CloudHttpResponse, CloudTransportFailed>;
}
export declare const CloudTransport: Context.Service<CloudTransport, CloudTransport>;
export interface CloudTransportScript {
    readonly request: CloudHttpRequest;
    readonly response: CloudHttpResponse | CloudTransportFailed;
}
export declare const CloudTransportTest: (scripts: ReadonlyArray<CloudTransportScript>) => Layer.Layer<CloudTransport, never, never>;
export declare const CloudTransportLive: (baseUrl: string, token: string) => Layer.Layer<CloudTransport, never, never>;
export interface CloudSpawnRequest {
    readonly task: string;
    readonly spec?: Readonly<Record<string, unknown>>;
    readonly headers?: Readonly<Record<string, string>>;
}
export interface CloudPollingOptions {
    readonly pollIntervalMs?: number;
    readonly maxAttempts?: number;
    readonly deadlineMs?: number;
    readonly retryAttempts?: number;
    readonly retryDelayMs?: number;
}
export interface CloudTerminalReceipt extends Readonly<Record<string, unknown>> {
    readonly runId: string;
    readonly taskFingerprint: string;
    readonly nonce: string;
    readonly summary: string;
    readonly ok?: boolean;
}
export interface CloudRunResult {
    readonly runId: string;
    readonly status: string;
    readonly ok: boolean;
    readonly terminal: CloudTerminalReceipt;
}
export interface CloudCancellation {
    readonly runId: string;
    readonly status: number;
    readonly body: unknown;
}
export interface CloudAdmission {
    readonly runId: string;
    readonly body: Readonly<Record<string, unknown>>;
}
export declare const pollCloudRun: (runId: string, options?: CloudPollingOptions) => Effect.Effect<CloudRunResult, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed | CloudResponseMalformed | CloudPollingExhausted, CloudTransport>;
export declare const admitCloudRun: (request: CloudSpawnRequest, options?: CloudPollingOptions) => Effect.Effect<CloudAdmission, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed | CloudResponseMalformed, CloudTransport>;
export declare const admitBackgroundCloudRun: (request: CloudSpawnRequest) => Effect.Effect<CloudAdmission, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed | CloudResponseMalformed, CloudTransport>;
export declare const cancelCloudRun: (runId: string, options?: CloudPollingOptions) => Effect.Effect<CloudCancellation, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed, CloudTransport>;
export declare const spawnCloudRun: (request: CloudSpawnRequest, options?: CloudPollingOptions) => Effect.Effect<CloudRunResult, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed | CloudResponseMalformed | CloudPollingExhausted, CloudTransport>;
export interface CloudClient {
    readonly admit: (request: CloudSpawnRequest, options?: CloudPollingOptions) => Effect.Effect<CloudAdmission, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed | CloudResponseMalformed, CloudTransport>;
    readonly admitBackground: (request: CloudSpawnRequest) => Effect.Effect<CloudAdmission, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed | CloudResponseMalformed, CloudTransport>;
    readonly spawn: (request: CloudSpawnRequest, options?: CloudPollingOptions) => Effect.Effect<CloudRunResult, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed | CloudResponseMalformed | CloudPollingExhausted, CloudTransport>;
    readonly poll: (runId: string, options?: CloudPollingOptions) => Effect.Effect<CloudRunResult, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed | CloudResponseMalformed | CloudPollingExhausted, CloudTransport>;
    readonly cancel: (runId: string, options?: CloudPollingOptions) => Effect.Effect<CloudCancellation, CloudConfigurationInvalid | CloudTransportFailed | CloudHttpFailed, CloudTransport>;
}
export declare const CloudClient: Context.Service<CloudClient, CloudClient>;
export declare const CloudClientLive: Layer.Layer<CloudClient, never, never>;
