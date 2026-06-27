import { spawnTerrariumBackground, getRunStatus, cancelRun } from "./core.js";
import { createRunGroup, getRunGroupStatus } from "./groups.js";
import { BATCH_API_VERSION, BATCH_SUPPORTED_OPTIONS, MCP_SCHEMA_VERSION } from "./versions.js";

export const BATCH_STRATEGIES = ["all", "allSettled", "race", "any", "quorum"];
const TERMINAL = ["done", "failed", "inconclusive", "cancelled", "error", "orphaned", "missing"];
const SUCCESS = ["done"];

function isTerminal(status) { return TERMINAL.includes(status); }
function isSuccess(run) { return SUCCESS.includes(run.status) && run.ok !== false; }

/**
 * Fan out an array of jobs as independent background Terrarium runs, grouped
 * under one correlation handle, and resolve according to a join strategy.
 *
 * Additive and opt-in: every job is a normal single spawn; nothing in the
 * single-spawn path changes. Strategies that pick a winner (race/any/quorum)
 * cancel the remaining runs via the existing cancelRun primitive.
 *
 * @param {object} opts
 * @param {Array<object>} opts.jobs       1-32 job option objects (each like a single spawn)
 * @param {string} [opts.strategy]        all | allSettled | race | any | quorum
 * @param {number} [opts.quorum]          required successes for the quorum strategy
 * @param {number} [opts.concurrency]     max simultaneously launched runs (default: all at once)
 * @param {string} [opts.label]           group label
 * @param {number} [opts.pollMs]          status poll interval (default 500)
 * @param {number} [opts.timeoutMs]       overall batch wait budget (default none)
 * @param {number} [opts.cleanupTimeoutMs] max synchronous cancellation settlement wait (default 5000)
 */
export async function spawnBatch(opts = {}) {
  const {
    jobs,
    strategy = "all",
    quorum,
    concurrency,
    label = "Terrarium batch",
    pollMs = 500,
    timeoutMs,
    cleanupTimeoutMs = 5000,
  } = opts;

  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 32) {
    throw new Error("batch requires 1-32 jobs");
  }
  if (!BATCH_STRATEGIES.includes(strategy)) {
    throw new Error(`invalid batch strategy: ${strategy} (expected ${BATCH_STRATEGIES.join(", ")})`);
  }
  let quorumTarget = null;
  if (strategy === "quorum") {
    quorumTarget = Number(quorum);
    if (!Number.isInteger(quorumTarget) || quorumTarget < 1 || quorumTarget > jobs.length) {
      throw new Error("quorum strategy requires an integer quorum between 1 and jobs.length");
    }
  }
  const limit = concurrency == null ? jobs.length : Number(concurrency);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("concurrency must be a positive integer");
  if (!Number.isFinite(Number(cleanupTimeoutMs)) || Number(cleanupTimeoutMs) < 0) throw new Error("cleanupTimeoutMs must be a non-negative number");

  const { started, launchError, launchErrors } = await launchBounded(jobs, limit);
  const runIds = started.filter(Boolean).map((run) => run.runId);
  if (runIds.length === 0) throw launchError;

  const group = await createRunGroup({ label, runIds });
  if (launchError) {
    const status = await getRunGroupStatus({ groupId: group.groupId });
    const cleanupErrors = await cancelLosers(status, { collectErrors: true, maxWaitMs: Number(cleanupTimeoutMs) });
    return {
      ok: false,
      apiVersion: BATCH_API_VERSION,
      schemaVersion: MCP_SCHEMA_VERSION,
      supportedOptions: BATCH_SUPPORTED_OPTIONS,
      strategy,
      groupId: group.groupId,
      runIds,
      reason: "launch-failed",
      launchError: launchError.message,
      launchErrors,
      launchedCount: runIds.length,
      unlaunchedCount: jobs.length - runIds.length,
      cleanupErrors,
      group: await getRunGroupStatus({ groupId: group.groupId }),
    };
  }

  const resolution = await awaitStrategy({
    groupId: group.groupId,
    strategy,
    quorumTarget,
    pollMs,
    timeoutMs,
    cleanupTimeoutMs: Number(cleanupTimeoutMs),
  });

  return {
    ok: resolution.ok,
    apiVersion: BATCH_API_VERSION,
    schemaVersion: MCP_SCHEMA_VERSION,
    supportedOptions: BATCH_SUPPORTED_OPTIONS,
    strategy,
    groupId: group.groupId,
    runIds,
    ...resolution,
  };
}

async function launchBounded(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  let stopped = false;
  async function worker() {
    while (!stopped) {
      const index = next++;
      if (index >= jobs.length) return;
      try {
        // A slot remains occupied until its run is terminal. Merely awaiting the
        // detached spawn would only bound launcher calls, not active children.
        const run = await spawnTerrariumBackground({ ...jobs[index], stream: false });
        results[index] = run;
        if (limit < jobs.length) await waitUntilTerminal(run.runId);
      } catch (error) {
        // A failed worker must close the shared launch gate. Without this handoff,
        // other workers continue consuming queued jobs after the batch is already
        // known to have a partial-launch failure.
        stopped = true;
        throw error;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, () => worker());
  const settled = await Promise.allSettled(workers);
  const rejected = settled.filter((result) => result.status === "rejected");
  const launchError = rejected[0]?.reason;
  const launchErrors = rejected.map((result) => String(result.reason?.message ?? result.reason));
  return { started: results, launchError, launchErrors };
}

async function waitUntilTerminal(runId, maxWaitMs = 30000) {
  const deadline = Date.now() + maxWaitMs;
  while (true) {
    const run = await getRunStatus({ runId });
    if (isTerminal(run.status)) return run;
    if (Date.now() >= deadline) throw new Error(`run did not become terminal after cancellation: ${runId}`);
    await sleep(100);
  }
}

async function awaitStrategy({ groupId, strategy, quorumTarget, pollMs, timeoutMs, cleanupTimeoutMs }) {
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
  while (true) {
    const status = await getRunGroupStatus({ groupId });
    const decision = decide(status, strategy, quorumTarget);
    if (decision.settled) {
      const cleanupErrors = decision.cancelLosers
        ? await cancelLosers(status, { collectErrors: true, maxWaitMs: cleanupTimeoutMs })
        : [];
      return {
        ...decision,
        cleanupErrors,
        group: await getRunGroupStatus({ groupId }),
      };
    }
    if (deadline && Date.now() >= deadline) {
      const cleanupErrors = await cancelLosers(status, { all: true, collectErrors: true, maxWaitMs: cleanupTimeoutMs });
      return {
        ok: false,
        reason: "timeout",
        timedOut: true,
        cleanupErrors,
        group: await getRunGroupStatus({ groupId }),
      };
    }
    await sleep(pollMs);
  }
}

function decide(status, strategy, quorumTarget) {
  const runs = status.runs;
  const terminal = runs.filter((run) => isTerminal(run.status));
  const successes = runs.filter(isSuccess);
  const allTerminal = terminal.length === runs.length;

  switch (strategy) {
    case "all":
      // Resolve only when everything finished; ok if every run succeeded.
      if (!allTerminal) return { settled: false };
      return { settled: true, ok: successes.length === runs.length, reason: "all-complete" };

    case "allSettled":
      // Never short-circuit. Settlement describes completion; ok still describes
      // whether every child succeeded, as it does for every other strategy.
      if (!allTerminal) return { settled: false };
      return { settled: true, ok: successes.length === runs.length, reason: "all-settled", successCount: successes.length, failureCount: runs.length - successes.length };

    case "race":
      // First terminal wins, whatever its outcome; cancel the rest.
      if (terminal.length === 0) return { settled: false };
      return { settled: true, cancelLosers: true, ok: isSuccess(terminal[0]), reason: "race-winner", winner: terminal[0].runId };

    case "any":
      // First SUCCESS wins; cancel the rest. Fail only if all terminal w/o success.
      if (successes.length > 0) return { settled: true, cancelLosers: true, ok: true, reason: "any-success", winner: successes[0].runId };
      if (allTerminal) return { settled: true, ok: false, reason: "any-exhausted" };
      return { settled: false };

    case "quorum":
      if (successes.length >= quorumTarget) return { settled: true, cancelLosers: true, ok: true, reason: "quorum-reached", winners: successes.slice(0, quorumTarget).map((r) => r.runId) };
      if (allTerminal) return { settled: true, ok: false, reason: "quorum-unreached", successCount: successes.length, quorum: quorumTarget };
      return { settled: false };

    default:
      return { settled: false };
  }
}

async function cancelLosers(status, { all = false, collectErrors = false, maxWaitMs = 5000 } = {}) {
  const targets = status.runs.filter((run) => run.status === "running");
  if (!all) {
    // keep none running; winners are already terminal
  }
  const failures = [];
  await Promise.all(targets.map(async (run) => {
    try {
      await cancelRun({ runId: run.runId });
      await waitUntilTerminal(run.runId, maxWaitMs);
    } catch (error) {
      failures.push(`${run.runId}: ${error.message}`);
    }
  }));
  if (failures.length && !collectErrors) throw new AggregateError(failures.map((message) => new Error(message)), `failed to settle ${failures.length} cancelled run(s)`);
  return failures;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
