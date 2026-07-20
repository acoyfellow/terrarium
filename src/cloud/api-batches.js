// Cloud Terrarium /api/batches fanout surface (northstar C1 slice).
//
// Routes:
//   POST /api/batches            -> admit N bounded tasks as one batch
//   GET  /api/batches/:batchId   -> aggregate status referencing child receipts
//
// DESIGN INVARIANTS (proof gates):
//   1. NO forked admission logic. Each task in a batch is admitted through the
//      SAME `admitOneRun()` path used by POST /api/runs. A batch is purely a
//      bounded composition of ordinary runs.
//   2. Peak live admissions never exceed `maxConcurrency` (capped at the
//      per-owner policy ceiling). The window throttles how many admits are
//      in flight at once.
//   3. The batch record REFERENCES child runIds only. It never inlines a child
//      receipt; each child's receipt stays authoritative in its RunControlDO.
//   4. FAILURE-TRUTH: aggregate status is DERIVED from the children's own
//      run-index records at read time. A batch is "done" only when every child
//      is terminal AND ok; any failed/cancelled/inconclusive child forces
//      "failed"; any running child keeps it "running". A non-success is NEVER
//      rolled up as success.
//
// Auth mirrors /api/runs exactly: explicit principal-auth, owner from env,
// never from the client. Cross-owner or unknown batchId reads normalize to 404
// so a probing caller cannot enumerate the batchId space.

import { authenticateOwner } from "./web-session.js";
import { admitOneRun } from "./api-runs.js";
import { putBatchRecord, getBatchRecord, aggregateBatch } from "./run-index.js";

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._~+/=-]{8,255}$/;
const BATCH_ID_RE = /^bat_[A-Za-z0-9_]+$/;
const MAX_TASKS = 100;
const OWNER_CONCURRENCY_CEILING = 8; // == DEFAULT_ADMISSION_POLICY.maxConcurrentPerOwner
const DEFAULT_MAX_CONCURRENCY = 4;

function mintBatchId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `bat_${Date.now().toString(36)}_${hex.slice(0, 12)}`;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

/**
 * Admit `tasks` through `admitOneRun`, never letting more than `maxConcurrency`
 * admissions be in flight simultaneously. Returns { childRunIds, peakLive,
 * rejected } where rejected carries any non-202 admit outcomes verbatim.
 *
 * Peak-live is measured as the maximum number of concurrently-pending
 * admitOneRun promises, proving the window is respected (proof gate 2).
 */
async function admitWindowed(request, env, ownerId, tasks, maxConcurrency, idempotencyKeyBase) {
  const childRunIds = [];
  const rejected = [];
  let live = 0;
  let peakLive = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++;
      const task = tasks[i];
      live++;
      if (live > peakLive) peakLive = live;
      try {
        // Per-child idempotency key derived deterministically from the batch
        // key + index, so a batch retry maps each child to the same run.
        const idem = `${idempotencyKeyBase}.${i}`;
        const res = await admitOneRun(request, env, ownerId, { task: task.task, spec: task.spec }, idem);
        if (res.status === 202) {
          let body = {};
          try { body = await res.json(); } catch { body = {}; }
          if (body?.runId) childRunIds.push(body.runId);
          else rejected.push({ index: i, status: 502, error: "admit-missing-runid" });
        } else {
          let body = {};
          try { body = await res.json(); } catch { body = {}; }
          rejected.push({ index: i, status: res.status, error: body?.error || body?.reason || "admit-failed" });
        }
      } catch (err) {
        rejected.push({ index: i, status: 500, error: err?.message || "admit-threw" });
      } finally {
        live--;
      }
    }
  }

  const pool = Array.from({ length: Math.min(maxConcurrency, tasks.length) }, () => worker());
  await Promise.all(pool);
  return { childRunIds, peakLive, rejected };
}

/** Route matcher. Returns null when no route matches. */
export async function handleApiBatches(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/batches")) return null;

  const auth = await authenticateOwner(request, env);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  const ownerId = auth.principalId;

  // POST /api/batches
  if (path === "/api/batches" && method === "POST") {
    const idempotencyKey = request.headers.get("idempotency-key") || "";
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return Response.json({ ok: false, error: "idempotency-key required" }, { status: 400 });
    }
    const body = await readJson(request);
    const rawTasks = Array.isArray(body?.tasks) ? body.tasks : null;
    if (!rawTasks || rawTasks.length === 0) {
      return Response.json({ ok: false, error: "tasks[] required" }, { status: 400 });
    }
    if (rawTasks.length > MAX_TASKS) {
      return Response.json({ ok: false, error: `too many tasks (max ${MAX_TASKS})` }, { status: 413 });
    }
    // Normalize each task entry: accept a bare string or { task, spec }.
    const tasks = [];
    for (const t of rawTasks) {
      const task = typeof t === "string" ? t : (typeof t?.task === "string" ? t.task : "");
      if (!task.trim()) return Response.json({ ok: false, error: "each task must be a non-empty string" }, { status: 400 });
      const spec = t && typeof t === "object" && t.spec && typeof t.spec === "object" ? t.spec : {};
      tasks.push({ task, spec });
    }
    let maxConcurrency = Number.isFinite(body?.maxConcurrency) ? Math.floor(body.maxConcurrency) : DEFAULT_MAX_CONCURRENCY;
    if (maxConcurrency < 1) maxConcurrency = 1;
    if (maxConcurrency > OWNER_CONCURRENCY_CEILING) maxConcurrency = OWNER_CONCURRENCY_CEILING;

    const batchId = mintBatchId();
    const { childRunIds, peakLive, rejected } = await admitWindowed(
      request, env, ownerId, tasks, maxConcurrency, idempotencyKey,
    );

    // Persist the batch record (references child runIds only).
    const kv = env.TERRARIUM_LEDGER;
    if (kv && typeof kv.put === "function") {
      await putBatchRecord(kv, { ownerId, batchId, childRunIds, maxConcurrency, createdAt: Date.now() });
    }

    return Response.json({
      ok: true,
      batchId,
      admitted: childRunIds.length,
      requested: tasks.length,
      maxConcurrency,
      peakLive,
      childRunIds,
      rejected,
    }, { status: 202 });
  }

  // GET /api/batches/:batchId
  const m = path.match(/^\/api\/batches\/([^/]+)$/);
  if (m && method === "GET") {
    const batchId = m[1];
    if (!BATCH_ID_RE.test(batchId)) {
      return Response.json({ ok: false, error: "invalid batch id" }, { status: 400 });
    }
    const kv = env.TERRARIUM_LEDGER;
    if (!kv || typeof kv.get !== "function") {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
    const record = await getBatchRecord(kv, ownerId, batchId);
    if (!record) return Response.json({ ok: false, error: "not found" }, { status: 404 });
    const agg = await aggregateBatch(kv, ownerId, record);
    return Response.json({ ok: true, ...agg });
  }

  if (path === "/api/batches" || m) {
    return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  }
  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}
