import { Effect, Fiber, Option, Queue, Ref, Result } from "effect";
import { BatchCancellationFailed, BatchConfigurationInvalid } from "../domain/errors.js";
import { supervise } from "./Supervisor.js";
export const BatchStrategies = ["all", "allSettled", "race", "any", "quorum"];
const defaultCancellationTimeoutMs = 5_000;
const isStrategy = (value) => BatchStrategies.includes(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isNonNegativeFiniteNumber = (value) => Number.isFinite(value) && value >= 0;
const configurationFailure = (field, reason) => new BatchConfigurationInvalid({ field, reason });
export const validateBatch = (jobCount, options = {}) => {
    if (!Number.isInteger(jobCount) || jobCount < 1) {
        return configurationFailure("jobs", "batch requires at least one job");
    }
    const strategy = options.strategy ?? "all";
    if (!isStrategy(strategy)) {
        return configurationFailure("strategy", "batch strategy is not supported");
    }
    const concurrency = options.concurrency ?? jobCount;
    if (!isPositiveInteger(concurrency)) {
        return configurationFailure("concurrency", "concurrency must be a positive integer");
    }
    const cancellationTimeoutMs = options.cancellationTimeoutMs ?? defaultCancellationTimeoutMs;
    if (!isNonNegativeFiniteNumber(cancellationTimeoutMs)) {
        return configurationFailure("cancellationTimeoutMs", "cancellation timeout must be a non-negative finite number");
    }
    if (strategy !== "quorum") {
        return { strategy, quorum: null, concurrency, cancellationTimeoutMs };
    }
    const quorum = options.quorum;
    if (quorum === undefined || !isPositiveInteger(quorum) || quorum > jobCount) {
        return configurationFailure("quorum", "quorum must be an integer between one and the job count");
    }
    return { strategy, quorum, concurrency, cancellationTimeoutMs };
};
const orderedOutcomes = (outcomes) => [...outcomes].sort((left, right) => left.index - right.index);
const successfulOutcomes = (outcomes) => outcomes.filter((outcome) => Result.isSuccess(outcome.result));
const batchResult = (strategy, reason, outcomes, ok, extra = {}) => {
    const successes = successfulOutcomes(outcomes);
    return {
        strategy,
        reason,
        ok,
        outcomes: orderedOutcomes(outcomes),
        successCount: successes.length,
        failureCount: outcomes.length - successes.length,
        ...extra
    };
};
const decide = (configuration, jobCount, outcomes) => {
    const successes = successfulOutcomes(outcomes);
    switch (configuration.strategy) {
        case "all":
            return outcomes.length === jobCount
                ? {
                    _tag: "Complete",
                    cancel: false,
                    result: batchResult("all", "all-complete", outcomes, successes.length === jobCount)
                }
                : { _tag: "Continue" };
        case "allSettled":
            return outcomes.length === jobCount
                ? {
                    _tag: "Complete",
                    cancel: false,
                    result: batchResult("allSettled", "all-settled", outcomes, successes.length === jobCount)
                }
                : { _tag: "Continue" };
        case "race": {
            const winner = outcomes[0];
            return winner === undefined
                ? { _tag: "Continue" }
                : {
                    _tag: "Complete",
                    cancel: true,
                    result: batchResult("race", "race-winner", outcomes, Result.isSuccess(winner.result), {
                        winner
                    })
                };
        }
        case "any": {
            const winner = successes[0];
            if (winner !== undefined) {
                return {
                    _tag: "Complete",
                    cancel: true,
                    result: batchResult("any", "any-success", outcomes, true, { winner })
                };
            }
            return outcomes.length === jobCount
                ? {
                    _tag: "Complete",
                    cancel: false,
                    result: batchResult("any", "any-exhausted", outcomes, false)
                }
                : { _tag: "Continue" };
        }
        case "quorum": {
            const quorum = configuration.quorum;
            if (quorum !== null && successes.length >= quorum) {
                const winners = successes.slice(0, quorum);
                return {
                    _tag: "Complete",
                    cancel: true,
                    result: batchResult("quorum", "quorum-reached", outcomes, true, { winners })
                };
            }
            return outcomes.length === jobCount
                ? {
                    _tag: "Complete",
                    cancel: false,
                    result: batchResult("quorum", "quorum-unreached", outcomes, false)
                }
                : { _tag: "Continue" };
        }
    }
};
const nextJob = (nextIndex, jobCount) => Ref.modify(nextIndex, (index) => index >= jobCount ? [null, index] : [index, index + 1]);
const worker = (jobs, nextIndex, completions) => nextJob(nextIndex, jobs.length).pipe(Effect.flatMap((index) => {
    if (index === null) {
        return Effect.void;
    }
    const job = jobs[index];
    return Effect.result(job).pipe(Effect.flatMap((result) => Queue.offer(completions, { index, result })), Effect.andThen(worker(jobs, nextIndex, completions)));
}));
const joinWorkers = (workers) => Effect.forEach(workers, Fiber.join, {
    concurrency: "unbounded",
    discard: true
});
const cancellationStatus = (workerId, completion) => Option.isNone(completion)
    ? { _tag: "StillSettling", workerId }
    : { _tag: "Settled", workerId };
const cancelWorkers = (workers, timeoutMs) => Effect.forEach(workers, (workerFiber) => Fiber.interrupt(workerFiber).pipe(Effect.timeoutOption(timeoutMs), Effect.map((completion) => cancellationStatus(workerFiber.id, completion))), { concurrency: "unbounded" }).pipe(Effect.flatMap((statuses) => {
    const stillSettlingWorkerIds = statuses
        .filter((status) => status._tag === "StillSettling")
        .map((status) => status.workerId);
    return stillSettlingWorkerIds.length === 0
        ? Effect.void
        : Effect.fail(new BatchCancellationFailed({ timeoutMs, stillSettlingWorkerIds }));
}));
const resolve = (configuration, jobCount, workers, completions) => {
    const collect = (outcomes) => Queue.take(completions).pipe(Effect.flatMap((completion) => {
        const nextOutcomes = [...outcomes, completion];
        const decision = decide(configuration, jobCount, nextOutcomes);
        if (decision._tag === "Continue") {
            return collect(nextOutcomes);
        }
        return decision.cancel
            ? cancelWorkers(workers, configuration.cancellationTimeoutMs).pipe(Effect.as(decision.result))
            : joinWorkers(workers).pipe(Effect.as(decision.result));
    }));
    return collect([]);
};
const executeValidatedBatch = (jobs, configuration) => Effect.gen(function* () {
    const nextIndex = yield* Ref.make(0);
    const workerCount = Math.min(configuration.concurrency, jobs.length);
    const completions = yield* Queue.bounded(workerCount);
    const workers = yield* Effect.forEach(Array.from({ length: workerCount }), () => worker(jobs, nextIndex, completions).pipe(Effect.forkChild({ startImmediately: true })));
    return yield* resolve(configuration, jobs.length, workers, completions);
});
export const executeBatch = (jobs, options = {}) => {
    const configuration = validateBatch(jobs.length, options);
    return configuration instanceof BatchConfigurationInvalid
        ? Effect.fail(configuration)
        : executeValidatedBatch(jobs, configuration);
};
export const superviseBatch = (requests, options = {}) => executeBatch(requests.map(supervise), options);
