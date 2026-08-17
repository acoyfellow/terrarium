import { Context, Effect, Layer, Option, Ref, Schedule } from "effect";
import * as Data from "effect/Data";
import { CloudConfigurationInvalid, CloudHttpFailed, CloudPollingExhausted, CloudResponseMalformed, CloudTransportFailed } from "../domain/errors.js";
export const CloudTransport = Context.Service("CloudTransport");
const sameBody = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sameRequest = (left, right) => left.method === right.method &&
    left.path === right.path &&
    sameBody(left.body, right.body) &&
    sameBody(left.headers, right.headers);
export const CloudTransportTest = (scripts) => Layer.succeed(CloudTransport, {
    request: (request) => {
        const script = scripts.find((candidate) => sameRequest(candidate.request, request));
        if (script === undefined) {
            return Effect.fail(new CloudTransportFailed({
                operation: request.method,
                path: request.path,
                reason: "No scripted HTTP response"
            }));
        }
        return script.response instanceof CloudTransportFailed
            ? Effect.fail(script.response)
            : Effect.succeed(script.response);
    }
});
const failureReason = (error) => error instanceof Error ? error.message : String(error);
export const CloudTransportLive = (baseUrl, token) => Layer.succeed(CloudTransport, {
    request: (request) => Effect.callback((resume, signal) => {
        const headers = {
            ...request.headers,
            authorization: `Bearer ${token}`
        };
        const hasBody = request.body !== undefined;
        if (hasBody) {
            headers["content-type"] = "application/json";
        }
        fetch(`${baseUrl}${request.path}`, {
            method: request.method,
            headers,
            signal,
            ...(hasBody ? { body: JSON.stringify(request.body) } : {})
        }).then((response) => {
            response.json().then((body) => resume(Effect.succeed({ status: response.status, body })), (error) => resume(Effect.fail(new CloudTransportFailed({
                operation: request.method,
                path: request.path,
                reason: failureReason(error)
            }))));
        }, (error) => resume(Effect.fail(new CloudTransportFailed({
            operation: request.method,
            path: request.path,
            reason: failureReason(error)
        }))));
    })
});
class RetryableCloudHttp extends Data.TaggedError("RetryableCloudHttp") {
}
const defaultPollingConfiguration = {
    pollIntervalMs: 1_000,
    maxAttempts: 150,
    deadlineMs: null,
    retryAttempts: 3,
    retryDelayMs: 250
};
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const pollingConfiguration = (options) => {
    const pollIntervalMs = options.pollIntervalMs ?? defaultPollingConfiguration.pollIntervalMs;
    const maxAttempts = options.maxAttempts ?? defaultPollingConfiguration.maxAttempts;
    const deadlineMs = options.deadlineMs ?? defaultPollingConfiguration.deadlineMs;
    const retryAttempts = options.retryAttempts ?? defaultPollingConfiguration.retryAttempts;
    const retryDelayMs = options.retryDelayMs ?? defaultPollingConfiguration.retryDelayMs;
    if (!nonNegativeInteger(pollIntervalMs)) {
        return new CloudConfigurationInvalid({
            field: "pollIntervalMs",
            reason: "poll interval must be a non-negative integer"
        });
    }
    if (!positiveInteger(maxAttempts)) {
        return new CloudConfigurationInvalid({
            field: "maxAttempts",
            reason: "maximum attempts must be a positive integer"
        });
    }
    if (deadlineMs !== null && !positiveInteger(deadlineMs)) {
        return new CloudConfigurationInvalid({
            field: "deadlineMs",
            reason: "deadline must be a positive integer"
        });
    }
    if (!nonNegativeInteger(retryAttempts)) {
        return new CloudConfigurationInvalid({
            field: "retryAttempts",
            reason: "retry attempts must be a non-negative integer"
        });
    }
    if (!nonNegativeInteger(retryDelayMs)) {
        return new CloudConfigurationInvalid({
            field: "retryDelayMs",
            reason: "retry delay must be a non-negative integer"
        });
    }
    return { pollIntervalMs, maxAttempts, deadlineMs, retryAttempts, retryDelayMs };
};
const objectRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
const isRetryableStatus = (status) => status === 408 || status === 429 || status >= 500;
const retrySchedule = (configuration) => Schedule.recurs(configuration.retryAttempts).pipe(Schedule.addDelay(() => Effect.succeed(configuration.retryDelayMs)), Schedule.while((metadata) => metadata.input instanceof CloudTransportFailed || metadata.input instanceof RetryableCloudHttp));
const classifiedResponse = (operation, request, acceptedStatus, response) => {
    const accepted = Array.isArray(acceptedStatus)
        ? acceptedStatus.includes(response.status)
        : response.status === acceptedStatus;
    if (accepted) {
        return Effect.succeed(response);
    }
    return isRetryableStatus(response.status)
        ? Effect.fail(new RetryableCloudHttp({
            operation,
            path: request.path,
            status: response.status,
            body: response.body
        }))
        : Effect.fail(new CloudHttpFailed({
            operation,
            path: request.path,
            status: response.status,
            body: response.body
        }));
};
const requestJson = (transport, operation, request, acceptedStatus, configuration) => {
    const classified = Effect.flatMap(transport.request(request), (response) => classifiedResponse(operation, request, acceptedStatus, response));
    const repeated = Effect.retry(classified, retrySchedule(configuration));
    return Effect.mapError(repeated, (error) => error instanceof RetryableCloudHttp
        ? new CloudHttpFailed({
            operation: error.operation,
            path: error.path,
            status: error.status,
            body: error.body
        })
        : error);
};
const malformed = (operation, path, body) => new CloudResponseMalformed({ operation, path, body });
const stringProperty = (record, key) => {
    const value = record[key];
    return typeof value === "string" ? value : null;
};
const terminalReceipt = (operation, path, body, value) => {
    const receipt = objectRecord(value);
    if (receipt === null) {
        return malformed(operation, path, body);
    }
    const runId = stringProperty(receipt, "runId");
    const taskFingerprint = stringProperty(receipt, "taskFingerprint");
    const nonce = stringProperty(receipt, "nonce");
    const summary = stringProperty(receipt, "summary");
    const ok = receipt.ok;
    if (runId === null ||
        taskFingerprint === null ||
        nonce === null ||
        summary === null ||
        (ok !== undefined && typeof ok !== "boolean")) {
        return malformed(operation, path, body);
    }
    return receipt;
};
const terminalStatus = (status) => status === "done" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "inconclusive" ||
    status === "error";
const pollObservation = (runId, path, body) => {
    const outer = objectRecord(body);
    const payload = outer === null ? null : objectRecord(outer.status) ?? outer;
    const status = payload === null ? null : stringProperty(payload, "status");
    if (payload === null || status === null) {
        return malformed("poll status", path, body);
    }
    if (!terminalStatus(status)) {
        return { _tag: "Running" };
    }
    const receipt = terminalReceipt("poll status", path, body, payload.terminal);
    if (receipt instanceof CloudResponseMalformed) {
        return receipt;
    }
    if (receipt.runId !== runId) {
        return malformed("poll status", path, body);
    }
    return {
        _tag: "Terminal",
        result: {
            runId,
            status,
            ok: receipt.ok ?? status === "done",
            terminal: receipt
        }
    };
};
const pollSchedule = (configuration) => Schedule.recurs(configuration.maxAttempts - 1).pipe(Schedule.addDelay(() => Effect.succeed(configuration.pollIntervalMs)), Schedule.while((metadata) => metadata.input._tag === "Running"));
const pollFailure = (runId, configuration) => new CloudPollingExhausted({
    runId,
    maxAttempts: configuration.maxAttempts,
    deadlineMs: configuration.deadlineMs
});
const pollWithConfiguration = (runId, configuration) => CloudTransport.use((transport) => Effect.gen(function* () {
    const path = `/api/runs/${encodeURIComponent(runId)}/status`;
    const latest = yield* Ref.make(Option.none());
    const poll = requestJson(transport, "poll status", { method: "GET", path }, 200, configuration).pipe(Effect.flatMap((response) => {
        const observation = pollObservation(runId, path, response.body);
        return observation instanceof CloudResponseMalformed
            ? Effect.fail(observation)
            : Effect.succeed(observation);
    }), Effect.tap((observation) => Ref.set(latest, Option.some(observation))));
    const repeated = poll.pipe(Effect.repeat(pollSchedule(configuration)));
    const bounded = configuration.deadlineMs === null
        ? repeated
        : repeated.pipe(Effect.timeoutOrElse({
            duration: configuration.deadlineMs,
            orElse: () => Effect.fail(pollFailure(runId, configuration))
        }));
    yield* bounded;
    const observation = yield* Ref.get(latest);
    return Option.isSome(observation) && observation.value._tag === "Terminal"
        ? observation.value.result
        : yield* Effect.fail(pollFailure(runId, configuration));
}));
export const pollCloudRun = (runId, options = {}) => {
    const configuration = pollingConfiguration(options);
    return configuration instanceof CloudConfigurationInvalid
        ? Effect.fail(configuration)
        : pollWithConfiguration(runId, configuration);
};
const admission = (transport, request, configuration) => requestJson(transport, "admit run", {
    method: "POST",
    path: "/api/runs",
    ...(request.headers === undefined ? {} : { headers: request.headers }),
    body: {
        task: request.task,
        ...(request.spec === undefined ? {} : { spec: request.spec })
    }
}, 202, configuration).pipe(Effect.flatMap((response) => {
    const body = objectRecord(response.body);
    const runId = body === null ? null : stringProperty(body, "runId");
    return body === null || runId === null
        ? Effect.fail(malformed("admit run", "/api/runs", response.body))
        : Effect.succeed({ runId, body });
}));
export const admitCloudRun = (request, options = {}) => {
    const configuration = pollingConfiguration(options);
    if (configuration instanceof CloudConfigurationInvalid) {
        return Effect.fail(configuration);
    }
    if (request.task.trim().length === 0) {
        return Effect.fail(new CloudConfigurationInvalid({ field: "task", reason: "task must not be empty" }));
    }
    return CloudTransport.use((transport) => admission(transport, request, configuration));
};
export const admitBackgroundCloudRun = (request) => admitCloudRun(request, { retryAttempts: 0 });
export const cancelCloudRun = (runId, options = {}) => {
    const configuration = pollingConfiguration(options);
    if (configuration instanceof CloudConfigurationInvalid) {
        return Effect.fail(configuration);
    }
    if (runId.trim().length === 0) {
        return Effect.fail(new CloudConfigurationInvalid({ field: "runId", reason: "run id must not be empty" }));
    }
    return CloudTransport.use((transport) => {
        const path = `/api/runs/${encodeURIComponent(runId)}/cancel`;
        return requestJson(transport, "cancel run", { method: "POST", path, body: {} }, [200, 202], configuration).pipe(Effect.map((response) => ({ runId, status: response.status, body: response.body })));
    });
};
export const spawnCloudRun = (request, options = {}) => {
    const configuration = pollingConfiguration(options);
    if (configuration instanceof CloudConfigurationInvalid) {
        return Effect.fail(configuration);
    }
    if (request.task.trim().length === 0) {
        return Effect.fail(new CloudConfigurationInvalid({ field: "task", reason: "task must not be empty" }));
    }
    return CloudTransport.use((transport) => admission(transport, request, configuration).pipe(Effect.flatMap((accepted) => pollWithConfiguration(accepted.runId, configuration))));
};
export const CloudClient = Context.Service("CloudClient");
export const CloudClientLive = Layer.succeed(CloudClient, {
    admit: admitCloudRun,
    admitBackground: admitBackgroundCloudRun,
    spawn: spawnCloudRun,
    poll: pollCloudRun,
    cancel: cancelCloudRun
});
