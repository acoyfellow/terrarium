import { Effect, Option, Ref, Result, Schema } from "effect";
import { ReceiptMalformed } from "../domain/errors.js";
import { Proc } from "./Proc.js";
import { RunStore } from "./RunStore.js";
const receiptMarker = "TERRARIUM_RESULT=";
export const TerminalReceipt = Schema.Struct({
    runId: Schema.String,
    taskFingerprint: Schema.String,
    nonce: Schema.String,
    summary: Schema.String
});
const TerminalReceiptJson = Schema.fromJsonString(TerminalReceipt);
const processOptions = (request) => ({
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs })
});
const receiptLine = (stdout) => stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(receiptMarker))
    ?.slice(receiptMarker.length);
const malformedReceipt = (runId, receipt) => new ReceiptMalformed({ runId, receipt });
const decodeReceipt = (runId, stdout) => {
    const encoded = receiptLine(stdout);
    if (encoded === undefined) {
        return Effect.fail(malformedReceipt(runId, stdout));
    }
    return Schema.decodeUnknownEffect(TerminalReceiptJson)(encoded).pipe(Effect.mapError(() => malformedReceipt(runId, encoded)), Effect.flatMap((receipt) => receipt.runId === runId
        ? Effect.succeed(receipt)
        : Effect.fail(malformedReceipt(runId, encoded))));
};
const captureReceipt = (request) => Proc.use((proc) => proc.capture(request.command, request.args, processOptions(request)).pipe(Effect.flatMap((process) => decodeReceipt(request.runId, process.stdout).pipe(Effect.map((receipt) => ({ ...process, receipt }))))));
const settle = (release, execution) => {
    if (Option.isSome(release) && Result.isFailure(release.value)) {
        return Effect.fail(release.value.failure);
    }
    return Result.isSuccess(execution)
        ? Effect.succeed(execution.success)
        : Effect.fail(execution.failure);
};
export const supervise = (request) => RunStore.use((store) => Effect.flatMap(Ref.make(Option.none()), (releaseResult) => Effect.flatMap(Effect.scoped(Effect.flatMap(Effect.acquireRelease(store.claim(request), (claimPath) => store.release(claimPath).pipe(Effect.result, Effect.andThen((result) => Ref.set(releaseResult, Option.some(result))))), () => Effect.result(captureReceipt(request)))), (execution) => Ref.get(releaseResult).pipe(Effect.flatMap((release) => settle(release, execution))))));
