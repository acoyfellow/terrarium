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
import { cloudboxEnabled, cloudboxRun } from "./cloudbox-client.js";

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

// Filesystem-dependency detector. The Cloudflare execution cell has NO access to
// the operator's local filesystem — a cloud run receives only {task, spec}. A
// task that asks the child to read/review a local path or repo therefore cannot
// be grounded in the cloud; the model, given a path with no files behind it,
// hallucinates plausible contents and returns a contract-valid-but-fabricated
// receipt. That is the t2t review incident (ter_mrrro4x*). We fail closed on it
// instead: a filesystem-dependent task must run locally (TERRARIUM_ALLOW_LOCAL=1,
// which copies the real cwd into the child) or inline its inputs into the task.
//
// Signals: an explicit cwd/isolation arg, or task text referencing an absolute
// local path, a repo directory, or a read-the-files instruction.
const FS_PATH_RE = /(^|\s)(\/Users\/|\/home\/|\/Volumes\/|~\/|\.\/|\.\.\/)[^\s"']*/;
const FS_INTENT_RE = /\b(read|review|inspect|audit|scan|open|cat|grep|list|diff|lint|test)\b[^.]{0,80}\b(repo|repository|codebase|the tree|working tree|src\/|the files?|directory|folder|\.(js|ts|tsx|jsx|py|rs|go|java|rb|md|json|svelte|toml|yaml|yml))\b/i;
export function detectFilesystemDependency(args = {}) {
  if (args.cwd && String(args.cwd).trim()) return { dependent: true, reason: `explicit cwd (${args.cwd}) — the cloud cell has no local filesystem` };
  if (args.isolation && args.isolation !== "none") return { dependent: true, reason: `isolation:${args.isolation} implies a local workspace the cloud cell cannot provide` };
  const task = String(args.task ?? "");
  if (FS_PATH_RE.test(task)) return { dependent: true, reason: "task references a local filesystem path; the cloud cell cannot read it" };
  if (FS_INTENT_RE.test(task)) return { dependent: true, reason: "task asks the child to read/review repository files; the cloud cell has no filesystem" };
  return { dependent: false };
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
  // Filesystem-dependent task handling. The Cloudflare cell has no operator
  // filesystem, so a grounded result is impossible here. Preference order:
  //   1. If a repo is provided AND Cloudbox is wired -> DELEGATE to Cloudbox
  //      (the sibling grounded cloud computer: real Git checkout + evidence).
  //   2. Else fail closed (never let the model fabricate a repo it can't read).
  const fsdep = detectFilesystemDependency(args);
  if (fsdep.dependent && env.TERRARIUM_CLOUD_ALLOW_UNGROUNDED !== "1") {
    const repo = args.repo ?? args.spec?.repo;
    if (repo && cloudboxEnabled(env)) {
      return await cloudboxRun(args, { env });
    }
    throw new Error(`cloud spawn refused: ${fsdep.reason}. The Cloudflare cell has no access to your local files, so a grounded result is impossible and the model would fabricate one (the t2t review incident). Choose grounding by what you're reviewing:\n  • LOCAL WORKING TREE incl. uncommitted edits (the usual case for reviewing work in progress) -> run LOCAL with --isolation copy (TERRARIUM_ALLOW_LOCAL=1). This copies your actual cwd — committed AND uncommitted — into the child. A cloud/cloudbox git-clone would only see committed HEAD and MISS your local changes.\n  • A COMMITTED public repo at HEAD -> delegate to Cloudbox: pass a \`repo\` (github URL) and set CLOUDBOX_URL (+ CLOUDBOX_TOKEN); Terrarium routes it to a real Git checkout with reproduce/verify receipts.\n  • Small inputs -> inline the file contents into the task text.\nTo force an ungrounded cloud run anyway, set TERRARIUM_CLOUD_ALLOW_UNGROUNDED=1.`);
  }
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
  // Fail closed if ANY job is filesystem-dependent (same reason as cloudSpawn):
  // the cloud cell can't read local files, so those jobs would fabricate results.
  if (env.TERRARIUM_CLOUD_ALLOW_UNGROUNDED !== "1") {
    const bad = (jobs || []).map((j, i) => ({ i, ...detectFilesystemDependency(j) })).filter((x) => x.dependent);
    if (bad.length) {
      return { ok: false, phase: "preflight", code: "filesystem-dependent", cloud: true,
        error: `cloud batch refused: ${bad.length} job(s) need the local filesystem the cloud cell lacks (job ${bad[0].i}: ${bad[0].reason}). Run locally (TERRARIUM_ALLOW_LOCAL=1) or inline file contents. Override with TERRARIUM_CLOUD_ALLOW_UNGROUNDED=1.`,
        filesystemDependentJobs: bad.map((x) => x.i) };
    }
  }
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

// ---- Cloud Pulse (terminal-callback) client -------------------------------
// The cloud cell routes each run's terminal event into a Pulse mailbox. These
// helpers let the Pi extension register a subscriber and pull/ack terminal
// callbacks over HTTP (TERRARIUM_URL + a pulse token), the cloud analogue of
// the local FS router the extension uses today.

export function pulseConfig(env = process.env) {
  const { url } = cloudConfig(env);
  let token = typeof env.TERRARIUM_PULSE_TOKEN === "string" ? env.TERRARIUM_PULSE_TOKEN : "";
  if (!token && env.TERRARIUM_PULSE_TOKEN_FILE) {
    try { token = readFileSync(env.TERRARIUM_PULSE_TOKEN_FILE, "utf8").trim(); } catch { /* empty */ }
  }
  return { url, token, configured: Boolean(url && token) };
}
export function pulseEnabled(env = process.env) { return pulseConfig(env).configured; }

async function pulseApi(path, body, config) {
  const res = await fetch(`${config.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { code: res.status, json };
}

const PULSE_TERMINAL_TYPES = ["Completed", "Failed", "TimedOut", "Cancelled"];

/** Register (or extend) a cloud Pulse subscriber for terminal events. */
export async function cloudPulseSubscribe(subscriberId, { env = process.env, runIds = ["*"] } = {}) {
  const config = pulseConfig(env);
  if (!config.configured) throw new Error("cloud pulse requires TERRARIUM_URL and a pulse token (TERRARIUM_PULSE_TOKEN / TERRARIUM_PULSE_TOKEN_FILE)");
  const r = await pulseApi("/pulse", { action: "subscribe", args: { subscriberId, runIds, channels: ["*"], workflowIds: ["*"], eventTypes: PULSE_TERMINAL_TYPES } }, config);
  return { ok: r.code === 200 && r.json?.ok !== false, ...(r.json?.result || {}), httpCode: r.code };
}

/** Claim pending terminal callbacks for a cloud subscriber. */
export async function cloudPulseClaim(subscriberId, { env = process.env, limit = 20 } = {}) {
  const config = pulseConfig(env);
  if (!config.configured) throw new Error("cloud pulse requires TERRARIUM_URL and a pulse token");
  const r = await pulseApi("/claim", { args: { subscriberId, limit } }, config);
  return { ok: r.code === 200, events: r.json?.result?.events || [], quarantined: r.json?.result?.quarantined || 0, httpCode: r.code };
}

/** Acknowledge a delivered cloud callback so it is not redelivered. */
export async function cloudPulseAck(subscriberId, eventId, { env = process.env } = {}) {
  const config = pulseConfig(env);
  if (!config.configured) throw new Error("cloud pulse requires TERRARIUM_URL and a pulse token");
  const r = await pulseApi("/ack", { args: { subscriberId, eventId } }, config);
  return { ok: r.code === 200, httpCode: r.code };
}
