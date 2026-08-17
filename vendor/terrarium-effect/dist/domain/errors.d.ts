declare const SpawnFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "SpawnFailed";
} & Readonly<A>;
export declare class SpawnFailed extends SpawnFailed_base<{
    readonly task: string;
    readonly reason: string;
}> {
}
declare const Timeout_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "Timeout";
} & Readonly<A>;
export declare class Timeout extends Timeout_base<{
    readonly runId: string;
    readonly timeoutMs: number;
}> {
}
declare const ClaimConflict_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ClaimConflict";
} & Readonly<A>;
export declare class ClaimConflict extends ClaimConflict_base<{
    readonly runId: string;
    readonly claimant: string;
}> {
}
declare const StoreReadFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "StoreReadFailed";
} & Readonly<A>;
export declare class StoreReadFailed extends StoreReadFailed_base<{
    readonly operation: string;
    readonly path: string;
    readonly reason: string;
    readonly code: string | null;
}> {
}
declare const StoreWriteFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "StoreWriteFailed";
} & Readonly<A>;
export declare class StoreWriteFailed extends StoreWriteFailed_base<{
    readonly operation: string;
    readonly path: string;
    readonly reason: string;
    readonly code: string | null;
}> {
}
declare const InvalidBudget_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "InvalidBudget";
} & Readonly<A>;
export declare class InvalidBudget extends InvalidBudget_base<{
    readonly value: string;
}> {
}
declare const ReceiptMalformed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ReceiptMalformed";
} & Readonly<A>;
export declare class ReceiptMalformed extends ReceiptMalformed_base<{
    readonly runId: string;
    readonly receipt: string;
}> {
}
declare const BatchConfigurationInvalid_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "BatchConfigurationInvalid";
} & Readonly<A>;
export declare class BatchConfigurationInvalid extends BatchConfigurationInvalid_base<{
    readonly field: string;
    readonly reason: string;
}> {
}
declare const BatchCancellationFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "BatchCancellationFailed";
} & Readonly<A>;
export declare class BatchCancellationFailed extends BatchCancellationFailed_base<{
    readonly timeoutMs: number;
    readonly stillSettlingWorkerIds: ReadonlyArray<number>;
}> {
}
declare const CloudTransportFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CloudTransportFailed";
} & Readonly<A>;
export declare class CloudTransportFailed extends CloudTransportFailed_base<{
    readonly operation: string;
    readonly path: string;
    readonly reason: string;
}> {
}
declare const CloudHttpFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CloudHttpFailed";
} & Readonly<A>;
export declare class CloudHttpFailed extends CloudHttpFailed_base<{
    readonly operation: string;
    readonly path: string;
    readonly status: number;
    readonly body: unknown;
}> {
}
declare const CloudResponseMalformed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CloudResponseMalformed";
} & Readonly<A>;
export declare class CloudResponseMalformed extends CloudResponseMalformed_base<{
    readonly operation: string;
    readonly path: string;
    readonly body: unknown;
}> {
}
declare const CloudPollingExhausted_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CloudPollingExhausted";
} & Readonly<A>;
export declare class CloudPollingExhausted extends CloudPollingExhausted_base<{
    readonly runId: string;
    readonly maxAttempts: number;
    readonly deadlineMs: number | null;
}> {
}
declare const CloudConfigurationInvalid_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CloudConfigurationInvalid";
} & Readonly<A>;
export declare class CloudConfigurationInvalid extends CloudConfigurationInvalid_base<{
    readonly field: string;
    readonly reason: string;
}> {
}
declare const CloudAdmissionAmbiguous_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CloudAdmissionAmbiguous";
} & Readonly<A>;
export declare class CloudAdmissionAmbiguous extends CloudAdmissionAmbiguous_base<{
    readonly index: number;
    readonly idempotencyKey: string | null;
    readonly runId: string | null;
    readonly reason: string;
}> {
}
declare const CloudReceiptCorrelationFailed_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CloudReceiptCorrelationFailed";
} & Readonly<A>;
export declare class CloudReceiptCorrelationFailed extends CloudReceiptCorrelationFailed_base<{
    readonly index: number;
    readonly runId: string;
    readonly expectedTaskFingerprint: string;
    readonly expectedNonce: string;
    readonly actualTaskFingerprint: string;
    readonly actualNonce: string;
}> {
}
export type RunError = SpawnFailed | Timeout | ClaimConflict | StoreReadFailed | StoreWriteFailed | InvalidBudget | ReceiptMalformed | BatchConfigurationInvalid | BatchCancellationFailed | CloudTransportFailed | CloudHttpFailed | CloudResponseMalformed | CloudPollingExhausted | CloudConfigurationInvalid | CloudAdmissionAmbiguous | CloudReceiptCorrelationFailed;
export {};
