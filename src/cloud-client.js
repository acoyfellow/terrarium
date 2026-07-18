// Cloud client for terrarium_spawn: submit a bounded task to a Cloudflare-run
// Terrarium execution cell (POST /api/runs) and return a spawn-shaped result.
//
// This is the seam that makes cloud the DEFAULT execution path for the MCP/CLI
// instead of local process spawn. Config via env:
//   TERRARIUM_URL                    e.g. https://terrarium.coey.dev  (or a qual slot)
//   TERRARIUM_CONTROL_TOKEN          Bearer token for that instance's principal
//   TERRARIUM_TOKEN_FILE             alternative: path to a file containing the token
//
// Request/response shape verified against the live cloud API (limits-probe.mjs,
// cloud-scale-eval.mjs): POST /api/runs {task, spec?} + Bearer + Idempotency-Key
// -> 202 {runId, contract:{runId,taskFingerprint,nonce}}; GET /api/runs/:id/status
// -> {status:{status, terminal:{...}}}.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { decide, validateBatchShape, BATCH_STRATEGIES } from "./batch.js";

export function cloudConfig(env = process.env) {
  const url = typeof env.TERRARIUM_URL === "string" ? env.TERRARIUM_URL.replace(/\/$/, "") : "";
  let token = typeof env.TERRARIUM_CONTROL_TOKEN === "string" ? env.TERRARIUM_CONTROL_TOKEN : "";
  if (!token && env.TERRARIUM_TOKEN_FILE) {
    try { token = readFileSync(env.TERRARIUM_TOKEN_FILE, "utf8").trim(); } catch { /* leave empty */ }
  }
  return { url, token, configured: Boolean(url && token) };
}

/** True when the operator has wired a cloud instance (URL + token). */
export function cloudEnabled(env = process.env) {
  return cloudConfig(env).configured;
}

// Cloud runIds are minted server-side as `ter_<base36ish>_<hex>` (e.g.
// ter_mrq8uwyp_cb0da25c6c4f), distinct from local `ter_<epoch>_<rand>` ids.
// Used to route status/read/cancel for a specific run to the right backend even
// if cloud is not the default, so a caller can always inspect a cloud run.
export function isCloudRunId(runId) {
  return typeof runId === "string" && /^ter_[a-z0-9]{6,10}_[a-f0-9]{8,}$/.test(runId);
}

async function api(path, { method = "GET", body, config } = {}) {
  const headers = { authorization: `Bearer ${config.token}` };
  if (body !== undefined) { headers["content-type"] = "application/json"; headers["idempotency-key"] = randomUUID(); }
  const res = await fetch(`${config.url}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { code: res.status, json };
}

/**
 * Submit one bounded task to the cloud and (unless background) poll to terminal.
 * Returns a result shaped like the local spawn result so the MCP projection and
 * callers are unchanged: { ok, runId, status, background?, contract?, terminal? }.
 */
export async function cloudSpawn(args = {}, { env = process.env, pollMs = 4000, maxPolls = 150 } = {}) {
  const config = cloudConfig(env);
  if (!config.configured) throw new Error("cloud spawn requires TERRARIUM_URL and TERRARIUM_CONTROL_TOKEN (or TERRARIUM_TOKEN_FILE)");
  const task = String(args.task ?? "");
  if (!task.trim()) throw new Error("missing task");
  const spec = {};
  if (Number.isFinite(args.timeoutMs)) spec.deadlineMs = Number(args.timeoutMs);
  if (args.model) spec.model = String(args.model);

  const submit = await api("/api/runs", { method: "POST", body: { task, ...(Object.keys(spec).length ? { spec } : {}) }, config });
  if (submit.code !== 202 || !submit.json?.runId) {
    return { ok: false, status: "rejected", cloud: true, httpCode: submit.code, error: submit.json?.error || submit.json?.raw || `admission failed (HTTP ${submit.code})`, contract: submit.json?.contract };
  }
  const runId = submit.json.runId;
  const contract = submit.json.contract;
  const executionRef = submit.json.executionRef;

  // Background: return the accepted runId immediately; caller polls status/pulls callback.
  if (args.background) {
    return { ok: true, runId, status: "running", background: true, cloud: true, contract, executionRef };
  }

  // Foreground: poll to terminal.
  for (let i = 0; i < maxPolls; i++) {
    const s = await api(`/api/runs/${runId}/status`, { config });
    const st = s.json?.status ?? s.json;
    const status = st?.status;
    if (["done", "failed", "cancelled", "inconclusive", "error"].includes(status)) {
      const terminal = st.terminal ?? {};
      return {
        ok: status === "done" && terminal.ok !== false,
        runId, status, cloud: true, contract, executionRef,
        exitCode: terminal.exitCode ?? null,
        taskContractStatus: terminal.taskContractStatus,
        taskResultSummary: terminal.taskResultSummary,
        reason: terminal.reason,
        terminal,
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, runId, status: "poll-timeout", cloud: true, contract, executionRef, error: "cloud run did not reach terminal within the poll window (still running; query status by runId)" };
}

/** Cloud run status, shaped like getRunStatus so conciseStatus works unchanged. */
export async function cloudStatus(runId, { env = process.env } = {}) {
  const config = cloudConfig(env);
  if (!config.configured) throw new Error("cloud status requires TERRARIUM_URL and a token");
  const s = await api(`/api/runs/${runId}/status`, { config });
  if (s.code === 404) return { runId, status: "not-found", ok: false, cloud: true };
  const st = s.json?.status ?? s.json;
  const terminal = st?.terminal ?? {};
  return {
    runId, cloud: true,
    status: st?.status,
    ok: terminal.ok ?? (st?.status === "done"),
    exitCode: terminal.exitCode ?? null,
    taskContractStatus: terminal.taskContractStatus,
    taskResultSummary: terminal.taskResultSummary,
    reason: terminal.reason,
    terminal,
  };
}

/** Cloud run logs, shaped like readRun ({ runId, text }). */
export async function cloudRead(runId, { env = process.env } = {}) {
  const config = cloudConfig(env);
  if (!config.configured) throw new Error("cloud read requires TERRARIUM_URL and a token");
  const s = await api(`/api/runs/${runId}/logs`, { config });
  if (s.code === 404) return { runId, cloud: true, text: "", error: "run not found on cloud instance" };
  const body = s.json ?? {};
  const text = typeof body.logs === "string" ? body.logs
    : Array.isArray(body.lines) ? body.lines.join("\n")
    : typeof body.text === "string" ? body.text
    : JSON.stringify(body);
  return { runId, cloud: true, text, logRefs: body.logRefs };
}

/** Cancel a cloud run (idempotent server-side). */
export async function cloudCancel(runId, { env = process.env } = {}) {
  const config = cloudConfig(env);
  if (!config.configured) throw new Error("cloud cancel requires TERRARIUM_URL and a token");
  const s = await api(`/api/runs/${runId}/cancel`, { method: "POST", body: {}, config });
  return { runId, cloud: true, cancelled: s.code === 200 || s.code === 202, httpCode: s.code, ...(s.json || {}) };
}

/**
 * Cloud batch fan-out. Submits each job as an independent cloud run, then polls
 * the SAME pure `decide()` used by the local batch so join semantics (all /
 * allSettled / race / any / quorum) are identical. Winner-picking strategies
 * cancel losing cloud runs via cloudCancel. No local group/status/cancel
 * machinery is involved — this is cloud-native fan-out.
 */
export async function cloudSpawnBatch(opts = {}, { env = process.env, pollMs = 3000, maxPolls = 200 } = {}) {
  const { jobs, strategy = "all", quorum, label = "Terrarium cloud batch", timeoutMs } = opts;
  const config = cloudConfig(env);
  if (!config.configured) throw new Error("cloud batch requires TERRARIUM_URL and a token");
  // Reuse the single-source batch-shape validation (job count, concurrency,
  // quorum bounds) so cloud and local batches can never drift.
  const verdict = validateBatchShape(opts);
  if (!verdict.ok) return { ok: false, phase: "preflight", code: verdict.code, error: verdict.error, cloud: true };
  const quorumTarget = strategy === "quorum" ? Number(quorum) : null;

  // Submit all jobs (background: return runId at admission). A job that fails
  // admission is recorded as a terminal failed run so conservation holds.
  const submitted = await Promise.all(jobs.map(async (job) => {
    try {
      const r = await cloudSpawn({ ...job, background: true }, { env });
      return r.runId ? { runId: r.runId, status: "running" } : { runId: null, status: "failed", ok: false, error: r.error };
    } catch (e) { return { runId: null, status: "failed", ok: false, error: e.message }; }
  }));
  const runIds = submitted.filter((s) => s.runId).map((s) => s.runId);
  if (runIds.length === 0) {
    return { ok: false, cloud: true, strategy, reason: "launch-failed", runIds: [], group: { runs: submitted } };
  }

  const deadline = timeoutMs > 0 ? Date.now() + Number(timeoutMs) : null;
  for (let i = 0; i < maxPolls; i++) {
    const runs = await Promise.all(runIds.map((id) => cloudStatus(id, { env }).catch((e) => ({ runId: id, status: "error", ok: false, error: e.message }))));
    const status = { runs };
    const d = decide(status, strategy, quorumTarget);
    if (d.settled) {
      if (d.cancelLosers) {
        const keep = new Set([d.winner, ...(d.winners || [])].filter(Boolean));
        await Promise.all(runs.filter((r) => !keep.has(r.runId) && !isTerminalStatus(r.status)).map((r) => cloudCancel(r.runId, { env }).catch(() => {})));
      }
      return { ok: d.ok, cloud: true, strategy, reason: d.reason, runIds, winner: d.winner, winners: d.winners, successCount: d.successCount, failureCount: d.failureCount, group: { complete: true, ok: d.ok, runs } };
    }
    if (deadline && Date.now() >= deadline) {
      await Promise.all(runs.filter((r) => !isTerminalStatus(r.status)).map((r) => cloudCancel(r.runId, { env }).catch(() => {})));
      return { ok: false, cloud: true, strategy, reason: "timeout", timedOut: true, runIds, group: { complete: false, runs } };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, cloud: true, strategy, reason: "poll-timeout", runIds, group: { complete: false } };
}

function isTerminalStatus(s) { return ["done", "failed", "cancelled", "inconclusive", "error"].includes(s); }
