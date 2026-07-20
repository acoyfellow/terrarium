// Per-principal run index — the control-plane projection that makes cloud runs
// (and terraloops) trackable across the one-DO-per-run boundary.
//
// WHY THIS EXISTS: RunControlDO is one durable cell per run, so there is no
// cross-run, cross-principal query surface. Without a projection, "show me what
// ran" is impossible. This module maintains a KV projection (binding
// TERRARIUM_LEDGER, already bound) written from the DO at two hook points:
//   • admit success   -> indexRunAdmitted (status "running")
//   • terminal (pulse) -> indexRunTerminal (final status + terminalAt)
//
// GROUPING KEY: channel, not workflowId. Measured (deja 01KXX4FZ79A5MJNH5RKEFN11GM):
// channel gives 100% clean clusters; workflowId defaults to own runId (a trap),
// so it is recorded only when explicitly set.
//
// GROUNDING: each record carries which backend produced the run
// (cloud | cloudbox | local-copy) so the control plane can show where a result
// was actually grounded.
//
// KEY SCHEME: `runidx:<ownerId>:<runId>`. Stable key so the terminal update
// targets the same record the admit wrote. createdAt lives in the value; recent
// ordering is a bounded in-memory sort at read time (the projection is small
// per principal and reads are bounded by `limit`).
//
// FAIL-SOFT: the index is an OBSERVABILITY projection, never the source of
// truth. Every write is best-effort and MUST NOT be able to fail an admission
// or a terminal callback. The DO wraps these calls so an index error is
// swallowed — the run's receipt/callback authority is unaffected.

const KEY_PREFIX = "runidx:";
const VALID_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const VALID_GROUNDING = new Set(["cloud", "cloudbox", "local-copy"]);
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

function keyFor(ownerId, runId) {
  return `${KEY_PREFIX}${ownerId}:${runId}`;
}

function sanitizeChannel(channel) {
  if (typeof channel !== "string") return null;
  const c = channel.trim();
  if (!c || c.length > 200) return null;
  return c;
}

function sanitizeGrounding(grounding) {
  return VALID_GROUNDING.has(grounding) ? grounding : "cloud";
}

// Record a newly-admitted run. Best-effort; returns true on write, false if the
// projection is unavailable or inputs are invalid (never throws for bad input —
// the caller is a durable hook that must not fail on projection problems).
export async function indexRunAdmitted(kv, {
  ownerId, runId, channel, workflowId, taskFingerprint, grounding, createdAt,
} = {}) {
  if (!kv || typeof kv.put !== "function") return false;
  if (!VALID_ID.test(String(ownerId ?? "")) || !VALID_ID.test(String(runId ?? ""))) return false;
  const record = {
    runId,
    ownerId,
    status: "running",
    channel: sanitizeChannel(channel),
    // workflowId is opt-in only; recorded when it differs from a trap default.
    workflowId: (typeof workflowId === "string" && workflowId && workflowId !== runId)
      ? workflowId.slice(0, 200) : null,
    taskFingerprint: typeof taskFingerprint === "string" ? taskFingerprint.slice(0, 128) : null,
    grounding: sanitizeGrounding(grounding),
    createdAt: Number.isFinite(createdAt) ? Number(createdAt) : Date.now(),
    terminalAt: null,
    ok: null,
  };
  try {
    await kv.put(keyFor(ownerId, runId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

// Update a run's index record to terminal. Merges onto the admit record if it
// exists; if the admit write was lost (fail-soft), it reconstructs a minimal
// terminal record so the run is still discoverable. Best-effort.
export async function indexRunTerminal(kv, {
  ownerId, runId, status, ok, channel, grounding, terminalAt,
} = {}) {
  if (!kv || typeof kv.put !== "function") return false;
  if (!VALID_ID.test(String(ownerId ?? "")) || !VALID_ID.test(String(runId ?? ""))) return false;
  let prior = null;
  try { prior = await kv.get(keyFor(ownerId, runId), { type: "json" }); } catch { prior = null; }
  const record = {
    runId,
    ownerId,
    status: typeof status === "string" ? status : "terminal",
    channel: sanitizeChannel(channel) ?? prior?.channel ?? null,
    workflowId: prior?.workflowId ?? null,
    taskFingerprint: prior?.taskFingerprint ?? null,
    grounding: prior?.grounding ?? sanitizeGrounding(grounding),
    createdAt: Number.isFinite(prior?.createdAt) ? prior.createdAt : (Number.isFinite(terminalAt) ? Number(terminalAt) : Date.now()),
    terminalAt: Number.isFinite(terminalAt) ? Number(terminalAt) : Date.now(),
    ok: typeof ok === "boolean" ? ok : null,
  };
  try {
    await kv.put(keyFor(ownerId, runId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

// List a principal's runs, most-recent-first, with optional filters. Bounded.
// Returns { runs, channels } where channels is a grouped rollup by channel.
export async function listPrincipalRuns(kv, ownerId, {
  channel, status, since, limit,
} = {}) {
  const empty = { runs: [], channels: {} };
  if (!kv || typeof kv.list !== "function") return empty;
  if (!VALID_ID.test(String(ownerId ?? ""))) return empty;
  const cap = Math.min(MAX_LIST_LIMIT, Math.max(1, Number.isFinite(limit) ? Number(limit) : DEFAULT_LIST_LIMIT));
  const prefix = `${KEY_PREFIX}${ownerId}:`;
  const records = [];
  let cursor;
  // Bounded scan: stop once we have plenty to sort/filter from.
  for (let page = 0; page < 20; page++) {
    let res;
    try { res = await kv.list({ prefix, cursor, limit: 1000 }); } catch { break; }
    const keys = res?.keys ?? [];
    for (const k of keys) {
      let rec;
      try { rec = await kv.get(k.name, { type: "json" }); } catch { rec = null; }
      if (rec) records.push(rec);
    }
    if (res?.list_complete || !res?.cursor) break;
    cursor = res.cursor;
    if (records.length >= MAX_LIST_LIMIT) break;
  }
  const wantChannel = sanitizeChannel(channel);
  const filtered = records.filter((r) => {
    if (wantChannel && r.channel !== wantChannel) return false;
    if (status && r.status !== status) return false;
    if (Number.isFinite(since) && !(Number(r.createdAt) >= Number(since))) return false;
    return true;
  });
  filtered.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  const runs = filtered.slice(0, cap);
  // Channel rollup for the control-plane grouping view.
  const channels = {};
  for (const r of runs) {
    const key = r.channel || "(none)";
    const g = channels[key] || (channels[key] = { channel: r.channel || null, total: 0, running: 0, done: 0, failed: 0, other: 0 });
    g.total++;
    if (r.status === "running") g.running++;
    else if (r.status === "done") g.done++;
    else if (r.status === "failed" || r.status === "cancelled" || r.status === "error") g.failed++;
    else g.other++;
  }
  return { runs, channels };
}

// ---------------------------------------------------------------------------
// Batch index (control-plane projection for /api/batches).
//
// A batch is N ordinary runs admitted through the SAME single-run admit path
// under a maxConcurrency window. The batch record REFERENCES child runIds only
// — each child's receipt stays authoritative in its own RunControlDO. This
// projection never inlines a receipt and is never the source of truth.
//
// KEY SCHEME: `batchidx:<ownerId>:<batchId>`. Aggregate status is DERIVED at
// read time from the children's own run-index records, so a batch can never
// report a child as "done" unless that child's record says so (failure-truth).
// ---------------------------------------------------------------------------

const BATCH_PREFIX = "batchidx:";

function batchKeyFor(ownerId, batchId) {
  return `${BATCH_PREFIX}${ownerId}:${batchId}`;
}

// Persist a batch record. Stores ONLY child runIds + window metadata — never a
// child receipt. Best-effort; returns false on invalid input or no binding.
export async function putBatchRecord(kv, {
  ownerId, batchId, childRunIds, maxConcurrency, createdAt,
} = {}) {
  if (!kv || typeof kv.put !== "function") return false;
  if (!VALID_ID.test(String(ownerId ?? "")) || !VALID_ID.test(String(batchId ?? ""))) return false;
  const ids = Array.isArray(childRunIds)
    ? childRunIds.filter((r) => VALID_ID.test(String(r ?? ""))).map(String).slice(0, 1000)
    : [];
  const record = {
    batchId,
    ownerId,
    childRunIds: ids,
    maxConcurrency: Number.isFinite(maxConcurrency) ? Number(maxConcurrency) : null,
    createdAt: Number.isFinite(createdAt) ? Number(createdAt) : Date.now(),
  };
  try {
    await kv.put(batchKeyFor(ownerId, batchId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

// Fetch a batch record by owner+batchId. Returns null when absent or on any
// read error (caller normalizes to 404 to avoid a batchId-enumeration oracle).
export async function getBatchRecord(kv, ownerId, batchId) {
  if (!kv || typeof kv.get !== "function") return null;
  if (!VALID_ID.test(String(ownerId ?? "")) || !VALID_ID.test(String(batchId ?? ""))) return null;
  try { return await kv.get(batchKeyFor(ownerId, batchId), { type: "json" }); } catch { return null; }
}

// Derive aggregate batch status from the CHILDREN's own run-index records.
// FAILURE-TRUTH: the batch is "done" only when every child is terminal AND ok
// is not false; any running child keeps it "running"; any failed/cancelled/
// error/inconclusive child forces "failed". Never rolls a non-success up as
// success. Returns { batchId, total, running, done, failed, status, children }
// where children reference runId + status only (receipts stay in their DOs).
export async function aggregateBatch(kv, ownerId, record) {
  const childRunIds = Array.isArray(record?.childRunIds) ? record.childRunIds : [];
  const children = [];
  for (const runId of childRunIds) {
    let rec = null;
    try { rec = await kv.get(keyFor(ownerId, runId), { type: "json" }); } catch { rec = null; }
    children.push({
      runId,
      status: rec?.status ?? "unknown",
      ok: typeof rec?.ok === "boolean" ? rec.ok : null,
      channel: rec?.channel ?? null,
      createdAt: rec?.createdAt ?? null,
      terminalAt: rec?.terminalAt ?? null,
    });
  }
  let running = 0, done = 0, failed = 0;
  for (const c of children) {
    if (c.status === "running" || c.status === "unknown") running++;
    else if (c.status === "done" && c.ok !== false) done++;
    else failed++; // failed | cancelled | error | done-but-not-ok | anything else
  }
  const total = children.length;
  // Status precedence: any failure => failed; else any still-running => running;
  // else all done => done. A non-success is NEVER surfaced as done.
  let status;
  if (failed > 0) status = "failed";
  else if (running > 0) status = "running";
  else if (total > 0 && done === total) status = "done";
  else status = "running";
  return {
    batchId: record.batchId,
    ownerId,
    maxConcurrency: record.maxConcurrency ?? null,
    createdAt: record.createdAt ?? null,
    total, running, done, failed, status, children,
  };
}

export const __test__ = { keyFor, KEY_PREFIX, sanitizeChannel, sanitizeGrounding, batchKeyFor, BATCH_PREFIX };
