import { randomUUID } from "node:crypto";
import {
  CloudTransport,
  CloudTransportFailed,
  Effect,
  Layer,
  executeCloudBatch,
  admitBackgroundCloudRun,
  admitCloudRun,
  pollCloudRun,
} from "terrarium-effect";
import { cloudConfig, detectFilesystemDependency } from "./cloud-client.js";
import { recordCloudAdmission } from "./core.js";
import { validateBatchShape } from "./batch.js";

const EFFECT_CLOUD_OPTIONS = new Set([
  "task",
  "background",
  "dryRun",
  "timeoutMs",
  "model",
  "channel",
  "workflowId",
  "verbose",
  "requireTaskContract",
]);

const EFFECT_BATCH_OPTIONS = new Set([
  "jobs",
  "strategy",
  "quorum",
  "concurrency",
  "timeoutMs",
  "cleanupTimeoutMs",
  "pollMs",
  "label",
]);

function parseBody(text) {
  try { return text ? JSON.parse(text) : {}; }
  catch { return { raw: text }; }
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("Effect CloudClient request aborted");
}

function cloudSpec(args) {
  const spec = {};
  if (Number.isFinite(args.timeoutMs)) spec.deadlineMs = Number(args.timeoutMs);
  if (args.model) spec.model = String(args.model);
  if (args.channel) spec.channel = String(args.channel);
  if (args.workflowId) spec.workflowId = String(args.workflowId);
  return spec;
}

function filesystemDependencyError(filesystem) {
  return `cloud spawn refused: ${filesystem.reason}. The Cloudflare cell has no access to your local files, so a grounded result is impossible and the model would fabricate one (the t2t review incident). Choose grounding by what you're reviewing:\n  • LOCAL WORKING TREE incl. uncommitted edits (the usual case for reviewing work in progress) -> run LOCAL with --isolation copy (TERRARIUM_ALLOW_LOCAL=1). This copies your actual cwd — committed AND uncommitted — into the child. A cloud/cloudbox git-clone would only see committed HEAD and MISS your local changes.\n  • A COMMITTED public repo at HEAD -> delegate to Cloudbox: pass a \`repo\` (github URL) and set CLOUDBOX_URL (+ CLOUDBOX_TOKEN); Terrarium routes it to a real Git checkout with reproduce/verify receipts.\n  • Small inputs -> inline the file contents into the task text.\nTo force an ungrounded cloud run anyway, set TERRARIUM_CLOUD_ALLOW_UNGROUNDED=1.`;
}

function validContract(contract, runId) {
  return contract && typeof contract === "object" &&
    contract.runId === runId &&
    typeof contract.taskFingerprint === "string" &&
    typeof contract.nonce === "string";
}

function validReceipt(receipt, contract, runId) {
  return receipt && typeof receipt === "object" &&
    receipt.runId === runId &&
    typeof receipt.taskFingerprint === "string" &&
    typeof receipt.nonce === "string" &&
    typeof receipt.summary === "string" &&
    (receipt.ok === undefined || typeof receipt.ok === "boolean") &&
    receipt.taskFingerprint === contract.taskFingerprint &&
    receipt.nonce === contract.nonce;
}

function correlation(idempotencyKey, runId = null) {
  return { idempotencyKey, runId };
}

function ambiguousAdmission(error, idempotencyKey, runId = null) {
  return {
    ok: false,
    status: "ambiguous-admission",
    cloud: true,
    effectCloud: true,
    idempotencyKey,
    correlation: correlation(idempotencyKey, runId),
    error: `Effect CloudClient admission is ambiguous. Reconcile with idempotency key ${idempotencyKey}${runId ? ` and runId ${runId}` : ""}: ${error}`,
  };
}

function admittedFailure(error, idempotencyKey, runId) {
  return {
    ok: false,
    runId,
    status: "ambiguous-effect-result",
    ambiguous: true,
    cloud: true,
    effectCloud: true,
    idempotencyKey,
    correlation: correlation(idempotencyKey, runId),
    error: `Effect CloudClient failed after admitting ${runId}. Reconcile with idempotency key ${idempotencyKey}: ${error}`,
  };
}

function failureMessage(error) {
  if (error && typeof error === "object") {
    if (typeof error.reason === "string") return error.reason;
    if (typeof error.message === "string") return error.message;
    if (typeof error.error === "string") return error.error;
    if (typeof error._tag === "string") return error._tag;
  }
  return String(error);
}

function unsupportedOption(args) {
  return Object.keys(args).find((key) => args[key] !== undefined && !EFFECT_CLOUD_OPTIONS.has(key));
}

function unsupportedBatchOption(args) {
  return Object.keys(args).find((key) => args[key] !== undefined && !EFFECT_BATCH_OPTIONS.has(key));
}

function batchIdempotencyKey(idempotencyKey, index) {
  return `${idempotencyKey}:${index}`;
}

function cloudBatchRequest(args, index, idempotencyKey, env) {
  assertEffectCloudForegroundCapability(args, { env });
  const spec = cloudSpec(args);
  return {
    task: args.task,
    ...(Object.keys(spec).length ? { spec } : {}),
    headers: { "idempotency-key": batchIdempotencyKey(idempotencyKey, index) },
  };
}

function effectResultValue(result) {
  return result?._tag === "Success" ? result.success : null;
}

function effectResultError(result) {
  return result?._tag === "Failure" ? failureMessage(result.failure) : null;
}

function terminalRun(run, outcome) {
  const value = effectResultValue(outcome?.result);
  if (value) {
    return {
      runId: run.runId,
      status: value.result.status,
      ok: value.result.terminal.ok !== false,
      exitCode: value.result.terminal.exitCode,
      taskContractStatus: value.result.terminal.taskContractStatus,
    };
  }
  const error = effectResultError(outcome?.result);
  return {
    runId: run.runId,
    status: error ? "failed" : "running",
    ok: error ? false : undefined,
    error: error ?? undefined,
  };
}

function winnerRunId(outcome) {
  return effectResultValue(outcome?.result)?.admission.runId;
}

function batchResult(execution, strategy) {
  const batch = execution.batch;
  const outcomes = new Map((batch?.outcomes ?? []).map((outcome) => [outcome.index, outcome]));
  const runs = execution.admissions.map((admission) => terminalRun(admission, outcomes.get(admission.index)));
  const cleanupErrors = execution.cancellationFailures.map((failure) => `${failure.runId}: ${failureMessage(failure.error)}`);
  const winner = winnerRunId(batch?.winner);
  const winners = batch?.winners?.map(winnerRunId).filter(Boolean);
  return {
    ok: batch?.ok ?? false,
    cloud: true,
    effectCloud: true,
    strategy: batch?.strategy ?? strategy,
    reason: batch?.reason ?? "timeout",
    timedOut: execution.timedOut,
    successCount: batch?.successCount ?? 0,
    failureCount: batch?.failureCount ?? 0,
    runIds: execution.admissions.map((admission) => admission.runId),
    ...(winner ? { winner } : {}),
    ...(winners?.length ? { winners } : {}),
    ...(cleanupErrors.length ? { cleanupErrors } : {}),
    group: {
      complete: batch !== null,
      ok: batch?.ok ?? false,
      runs,
    },
    admissions: execution.admissions,
    cancellations: execution.cancellations,
    ...(execution.cancellationFailures.length ? { cancellationFailures: execution.cancellationFailures } : {}),
  };
}

export function assertEffectCloudForegroundCapability(args = {}, { env = process.env } = {}) {
  if (args.dryRun === true) throw new Error("Effect CloudClient does not execute dry-run plans");
  if (typeof args.task !== "string" || !args.task.trim()) throw new Error("Effect CloudClient requires a non-empty task");
  const filesystem = detectFilesystemDependency(args);
  if (filesystem.dependent && env.TERRARIUM_CLOUD_ALLOW_UNGROUNDED !== "1") {
    throw new Error(filesystemDependencyError(filesystem));
  }
  if (args.timeoutMs !== undefined && !Number.isFinite(args.timeoutMs)) {
    throw new Error("Effect CloudClient requires timeoutMs to be finite when provided");
  }
  const unsupported = unsupportedOption(args);
  if (unsupported) throw new Error(`Effect CloudClient does not support cloud option: ${unsupported}`);
}

async function admitRun({ config, fetchImpl, task, spec, idempotencyKey, retryAttempts, retryDelayMs, signal, background = false }) {
  const request = {
    task,
    ...(Object.keys(spec).length ? { spec } : {}),
    headers: { "idempotency-key": idempotencyKey },
  };
  const admission = background
    ? admitBackgroundCloudRun(request)
    : admitCloudRun(request, { retryAttempts, retryDelayMs });
  try {
    const accepted = await Effect.runPromise(Effect.provide(admission, effectTransportLayer(config, fetchImpl, signal)));
    return { status: 202, body: accepted.body };
  } catch (error) {
    if (error?._tag === "CloudHttpFailed" && !retryableStatus(error.status)) {
      return { status: error.status, body: error.body };
    }
    return { ambiguous: failureMessage(error) };
  }
}

function effectTransportLayer(config, fetchImpl, signal) {
  return Layer.succeed(CloudTransport, {
    request: (request) => Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(`${config.url}${request.path}`, {
          method: request.method,
          headers: { ...request.headers, authorization: `Bearer ${config.token}` },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal,
        });
        return { status: response.status, body: parseBody(await response.text()) };
      },
      catch: (error) => new CloudTransportFailed({
        operation: request.method,
        path: request.path,
        reason: failureMessage(error),
      }),
    }),
  });
}

async function pollAdmittedRun(runId, { config, fetchImpl, pollMs, maxPolls, retryAttempts, retryDelayMs, signal }) {
  const polling = pollCloudRun(runId, {
    pollIntervalMs: pollMs,
    maxAttempts: maxPolls,
    retryAttempts,
    retryDelayMs,
  });
  return Effect.runPromise(Effect.provide(polling, effectTransportLayer(config, fetchImpl, signal)));
}

async function submitEffectCloudAdmission(args, {
  env,
  fetchImpl,
  idempotencyKey,
  retryAttempts,
  retryDelayMs,
  signal,
}, background) {
  const config = cloudConfig(env);
  if (!config.configured) throw new Error("effect cloud spawn requires TERRARIUM_URL and TERRARIUM_CONTROL_TOKEN (or TERRARIUM_TOKEN_FILE)");
  assertEffectCloudForegroundCapability(args, { env });
  if (typeof fetchImpl !== "function") throw new Error("effect cloud client requires fetch");

  const admission = await admitRun({
    config,
    fetchImpl,
    task: args.task,
    spec: cloudSpec(args),
    idempotencyKey,
    retryAttempts,
    retryDelayMs,
    signal,
    background,
  });
  if (admission.ambiguous) return { result: ambiguousAdmission(admission.ambiguous, idempotencyKey) };
  if (admission.status !== 202) {
    return {
      result: {
        ok: false,
        status: "rejected",
        cloud: true,
        effectCloud: true,
        httpCode: admission.status,
        idempotencyKey,
        correlation: correlation(idempotencyKey),
        error: admission.body?.error || admission.body?.raw || `admission failed (HTTP ${admission.status})`,
        contract: admission.body?.contract,
      },
    };
  }

  const runId = admission.body?.runId;
  const contract = admission.body?.contract;
  if (typeof runId !== "string" || !validContract(contract, runId)) {
    return { result: ambiguousAdmission("admission response omitted a valid correlated contract", idempotencyKey, typeof runId === "string" ? runId : null) };
  }

  return { config, runId, contract, executionRef: admission.body.executionRef };
}

async function persistCloudAdmission(args, { runId, contract, executionRef }, { idempotencyKey, onAdmitted, recordAdmission, background }) {
  try { onAdmitted?.({ runId, contract, executionRef, idempotencyKey }); } catch {}
  await recordAdmission({
    runId,
    channel: args.channel ?? null,
    workflowId: args.workflowId ?? null,
    task: args.task,
    model: args.model ?? null,
    contract,
    executionRef,
    background,
  }).catch(() => {});
}

export async function effectCloudAdmitBackground(args = {}, {
  env = process.env,
  idempotencyKey = randomUUID(),
  fetchImpl = globalThis.fetch,
  signal,
  onAdmitted,
  recordAdmission = recordCloudAdmission,
} = {}) {
  const admitted = await submitEffectCloudAdmission(args, {
    env,
    fetchImpl,
    idempotencyKey,
    retryAttempts: 0,
    retryDelayMs: 0,
    signal,
  }, true);
  if (admitted.result) return admitted.result;

  const { runId, contract, executionRef } = admitted;
  await persistCloudAdmission(args, admitted, { idempotencyKey, onAdmitted, recordAdmission, background: true });
  return {
    ok: true,
    runId,
    status: "running",
    background: true,
    cloud: true,
    effectCloud: true,
    contract,
    executionRef,
    idempotencyKey,
    correlation: correlation(idempotencyKey, runId),
  };
}

export async function effectCloudSpawnBatch(args = {}, {
  env = process.env,
  idempotencyKey = randomUUID(),
  fetchImpl = globalThis.fetch,
  signal,
  recordAdmission = recordCloudAdmission,
} = {}) {
  const config = cloudConfig(env);
  if (!config.configured) throw new Error("effect cloud batch requires TERRARIUM_URL and TERRARIUM_CONTROL_TOKEN (or TERRARIUM_TOKEN_FILE)");
  if (typeof fetchImpl !== "function") throw new Error("effect cloud client requires fetch");
  const unsupported = unsupportedBatchOption(args);
  if (unsupported) throw new Error(`Effect CloudClient does not support cloud batch option: ${unsupported}`);

  const preflight = validateBatchShape(args);
  if (!preflight.ok) {
    return { ok: false, phase: "preflight", code: preflight.code, error: preflight.error, cloud: true, effectCloud: true };
  }

  if (env.TERRARIUM_CLOUD_ALLOW_UNGROUNDED !== "1") {
    const filesystemDependentJobs = args.jobs
      .map((job, index) => ({ index, ...detectFilesystemDependency(job) }))
      .filter((job) => job.dependent);
    if (filesystemDependentJobs.length) {
      return {
        ok: false,
        phase: "preflight",
        code: "filesystem-dependent",
        cloud: true,
        effectCloud: true,
        error: `cloud batch refused: ${filesystemDependentJobs.length} job(s) need the local filesystem the cloud cell lacks (job ${filesystemDependentJobs[0].index}: ${filesystemDependentJobs[0].reason}). Run locally (TERRARIUM_ALLOW_LOCAL=1) or inline file contents. Override with TERRARIUM_CLOUD_ALLOW_UNGROUNDED=1.`,
        filesystemDependentJobs: filesystemDependentJobs.map((job) => job.index),
      };
    }
  }

  const jobs = args.jobs.map((job, index) => cloudBatchRequest(job, index, idempotencyKey, env));
  let execution;
  try {
    execution = await Effect.runPromise(Effect.provide(
      executeCloudBatch({
        jobs,
        strategy: args.strategy,
        quorum: args.quorum,
        concurrency: args.concurrency,
        cancellationTimeoutMs: args.cleanupTimeoutMs,
        timeoutMs: args.timeoutMs,
        polling: { pollIntervalMs: args.pollMs },
      }),
      effectTransportLayer(config, fetchImpl, signal),
    ));
  } catch (error) {
    return {
      ok: false,
      cloud: true,
      effectCloud: true,
      strategy: args.strategy ?? "all",
      reason: "execution-failed",
      error: failureMessage(error),
    };
  }

  await Promise.all(execution.admissions.map((admission) => recordAdmission({
    runId: admission.runId,
    channel: args.jobs[admission.index].channel ?? null,
    workflowId: args.jobs[admission.index].workflowId ?? null,
    task: args.jobs[admission.index].task,
    model: args.jobs[admission.index].model ?? null,
    contract: admission.contract,
    executionRef: admission.body.executionRef,
    background: false,
  }).catch(() => {})));

  return batchResult(execution, args.strategy ?? "all");
}

export async function effectCloudSpawn(args = {}, options = {}) {
  if (args.background === true) return effectCloudAdmitBackground(args, options);

  const {
    env = process.env,
    pollMs = 4000,
    maxPolls = 150,
    idempotencyKey = randomUUID(),
    fetchImpl = globalThis.fetch,
    retryAttempts = 3,
    retryDelayMs = 250,
    signal,
    onAdmitted,
    recordAdmission = recordCloudAdmission,
  } = options;
  const admitted = await submitEffectCloudAdmission(args, {
    env,
    fetchImpl,
    idempotencyKey,
    retryAttempts,
    retryDelayMs,
    signal,
  }, false);
  if (admitted.result) return admitted.result;

  const { config, runId, contract, executionRef } = admitted;
  await persistCloudAdmission(args, admitted, { idempotencyKey, onAdmitted, recordAdmission, background: false });
  let polled;
  try {
    polled = await pollAdmittedRun(runId, { config, fetchImpl, pollMs, maxPolls, retryAttempts, retryDelayMs, signal });
  } catch (error) {
    return admittedFailure(failureMessage(error), idempotencyKey, runId);
  }
  if (!validReceipt(polled.terminal, contract, runId)) {
    return admittedFailure("terminal receipt is malformed or does not match the admitted contract", idempotencyKey, runId);
  }
  return {
    ok: polled.status === "done" && polled.terminal.ok !== false,
    runId,
    status: polled.status,
    cloud: true,
    effectCloud: true,
    contract,
    executionRef,
    idempotencyKey,
    correlation: correlation(idempotencyKey, runId),
    exitCode: polled.terminal.exitCode ?? null,
    taskContractStatus: polled.terminal.taskContractStatus,
    taskResultSummary: polled.terminal.taskResultSummary ?? polled.terminal.summary,
    reason: polled.terminal.reason,
    terminal: polled.terminal,
  };
}

