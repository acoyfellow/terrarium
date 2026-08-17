import { Effect, Exit, Option, Ref, Result } from "effect";
import { CloudAdmissionAmbiguous, CloudConfigurationInvalid, CloudHttpFailed, CloudReceiptCorrelationFailed, CloudTransportFailed } from "../domain/errors.js";
import { admitCloudRun, cancelCloudRun, pollCloudRun } from "./CloudClient.js";
import { executeBatch } from "./Batch.js";
const objectRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
const stringProperty = (record, key) => {
    const value = record[key];
    return typeof value === "string" ? value : null;
};
const idempotencyKey = (request) => request.headers?.["idempotency-key"] ?? null;
const ambiguousAdmission = (index, request, runId, reason) => new CloudAdmissionAmbiguous({
    index,
    idempotencyKey: idempotencyKey(request),
    runId,
    reason
});
const admissionContract = (index, request, admission) => {
    const contract = objectRecord(admission.body.contract);
    const runId = contract === null ? null : stringProperty(contract, "runId");
    const taskFingerprint = contract === null ? null : stringProperty(contract, "taskFingerprint");
    const nonce = contract === null ? null : stringProperty(contract, "nonce");
    if (runId === null ||
        taskFingerprint === null ||
        nonce === null ||
        runId !== admission.runId) {
        return ambiguousAdmission(index, request, admission.runId, "admission response omitted a valid correlated contract");
    }
    return { runId, taskFingerprint, nonce };
};
const retryableAdmissionFailure = (error) => error.status === 408 || error.status === 429 || error.status >= 500;
const normalizeAdmissionFailure = (index, request, error) => {
    if (error instanceof CloudTransportFailed) {
        return ambiguousAdmission(index, request, null, error.reason);
    }
    if (error instanceof CloudHttpFailed && retryableAdmissionFailure(error)) {
        return ambiguousAdmission(index, request, null, `HTTP ${error.status}`);
    }
    return error;
};
const captureCancellation = (state, index, runId, polling) => Effect.uninterruptible(cancelCloudRun(runId, polling).pipe(Effect.matchEffect({
    onFailure: (error) => Ref.update(state.cancellationFailures, (failures) => [
        ...failures,
        { index, runId, error }
    ]),
    onSuccess: (cancellation) => Ref.update(state.cancellations, (cancellations) => [
        ...cancellations,
        {
            index,
            runId: cancellation.runId,
            status: cancellation.status,
            body: cancellation.body
        }
    ])
})));
const receiptCorrelationFailure = (index, admission, result) => {
    const receipt = result.terminal;
    if (receipt.runId === admission.runId &&
        receipt.taskFingerprint === admission.contract.taskFingerprint &&
        receipt.nonce === admission.contract.nonce) {
        return null;
    }
    return new CloudReceiptCorrelationFailed({
        index,
        runId: admission.runId,
        expectedTaskFingerprint: admission.contract.taskFingerprint,
        expectedNonce: admission.contract.nonce,
        actualTaskFingerprint: receipt.taskFingerprint,
        actualNonce: receipt.nonce
    });
};
const cloudJob = (index, request, polling, state) => {
    const acquire = admitCloudRun(request, polling).pipe(Effect.mapError((error) => normalizeAdmissionFailure(index, request, error)), Effect.flatMap((accepted) => {
        const contract = admissionContract(index, request, accepted);
        if (contract instanceof CloudAdmissionAmbiguous) {
            return captureCancellation(state, index, accepted.runId, polling).pipe(Effect.andThen(Effect.fail(contract)));
        }
        const admission = {
            index,
            runId: accepted.runId,
            contract,
            idempotencyKey: idempotencyKey(request),
            body: accepted.body
        };
        return Ref.update(state.admissions, (admissions) => [...admissions, admission]).pipe(Effect.as(admission));
    }));
    return Effect.acquireUseRelease(acquire, (admission) => pollCloudRun(admission.runId, polling).pipe(Effect.flatMap((result) => {
        const failure = receiptCorrelationFailure(index, admission, result);
        return failure === null
            ? Effect.succeed({ index, admission, result })
            : Effect.fail(failure);
    })), (admission, exit) => Exit.hasInterrupts(exit)
        ? captureCancellation(state, index, admission.runId, polling)
        : Effect.void);
};
const orderedByIndex = (values) => [...values].sort((left, right) => left.index - right.index);
const validTimeout = (timeoutMs) => timeoutMs === undefined || (Number.isFinite(timeoutMs) && timeoutMs >= 0);
export const executeCloudBatch = (request) => {
    if (!validTimeout(request.timeoutMs)) {
        return Effect.fail(new CloudConfigurationInvalid({
            field: "timeoutMs",
            reason: "timeout must be a non-negative finite number"
        }));
    }
    return Effect.gen(function* () {
        const state = {
            admissions: yield* Ref.make([]),
            cancellations: yield* Ref.make([]),
            cancellationFailures: yield* Ref.make([])
        };
        const polling = request.polling ?? {};
        const batch = executeBatch(request.jobs.map((job, index) => cloudJob(index, job, polling, state)), {
            ...(request.strategy === undefined ? {} : { strategy: request.strategy }),
            ...(request.quorum === undefined ? {} : { quorum: request.quorum }),
            ...(request.concurrency === undefined ? {} : { concurrency: request.concurrency }),
            ...(request.cancellationTimeoutMs === undefined
                ? {}
                : { cancellationTimeoutMs: request.cancellationTimeoutMs })
        });
        const completed = request.timeoutMs !== undefined && request.timeoutMs > 0
            ? yield* Effect.timeoutOption(batch, request.timeoutMs)
            : Option.some(yield* batch);
        return {
            batch: Option.isSome(completed) ? completed.value : null,
            timedOut: Option.isNone(completed),
            admissions: orderedByIndex(yield* Ref.get(state.admissions)),
            cancellations: orderedByIndex(yield* Ref.get(state.cancellations)),
            cancellationFailures: orderedByIndex(yield* Ref.get(state.cancellationFailures))
        };
    });
};
export const successfulCloudBatchRuns = (execution) => execution.batch === null
    ? []
    : execution.batch.outcomes.flatMap((outcome) => Result.isSuccess(outcome.result) ? [outcome.result.success] : []);
