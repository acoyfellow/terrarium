// Cloud Terrarium production /api/runs HTTP surface.
//
// Routes:
//   POST /api/runs                        -> admit one run
//   GET  /api/runs/:runId/status
//   GET  /api/runs/:runId/logs
//   POST /api/runs/:runId/cancel
//
// Authentication (Round 5C1):
//   Explicit principal-auth via env.TERRARIUM_PRINCIPAL_ID plus one of the
//   two independent verification tokens (TERRARIUM_CONTROL_TOKEN_CURRENT
//   with optional TERRARIUM_CONTROL_TOKEN_PREVIOUS for rotation). Owner
//   identity is the principal from env, never derived from the token, never
//   accepted from the client. The legacy env.TERRARIUM_CONTROL_TOKEN does
//   NOT authorize /api/runs.
//
// Budget: every admit passes through the PrincipalBudgetDO (singleton per
// principal) BEFORE calling into RunControl. The budget DO strongly orders
// idempotency, active reservations, per-minute + per-day counts, and
// estimated token/cost limits. Non-202 RunDO responses roll the reservation
// back idempotently. Terminal callback path releases the reservation.
//
// Every request goes through the RunControlDO for the run — one DO per runId.
// The worker does NOT execute any task itself; it is a thin auth+router.

import { authenticatePrincipal } from "./principal-auth.js";
import {
  canonicalRequestHash,
  estimateBudgetFromTask,
  resolveBudgetLimits,
} from "./principal-budget-do.js";

const RUN_ID_RE = /^ter_[A-Za-z0-9_]+$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._~+/=-]{8,255}$/;

function mintRunId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ter_${Date.now().toString(36)}_${hex.slice(0, 12)}`;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function doStubForRun(env, runId) {
  const ns = env.TERRARIUM_RUN;
  if (!ns) throw Object.assign(new Error("TERRARIUM_RUN binding missing"), { status: 500 });
  return ns.get(ns.idFromName(runId));
}

function budgetStubForPrincipal(env, principalId) {
  const ns = env.TERRARIUM_PRINCIPAL_BUDGET;
  if (!ns || typeof ns.idFromName !== "function") return null;
  return ns.get(ns.idFromName(principalId));
}

async function proxy(request, stub, path, method, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return stub.fetch(`https://do/${path}`, init);
}

/** Normalize authenticated-but-cross-owner-or-unknown reads to a generic
 *  404 so a probing caller cannot enumerate the runId space. */
function normalizeNotFound(res) {
  if (res.status === 403 || res.status === 404) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  return res;
}

/** Best-effort idempotent budget release. Never throws — release failures
 *  are logged via response body but must not corrupt the API response. */
async function releaseBudget(env, principalId, runId) {
  const stub = budgetStubForPrincipal(env, principalId);
  if (!stub) return { ok: false, reason: "no-binding" };
  try {
    const res = await stub.fetch("https://do/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId, runId }),
    });
    return { ok: res.ok };
  } catch (err) {
    return { ok: false, reason: err?.message || "release-failed" };
  }
}

/** Route matcher. Returns null when no route matches — caller should return 404. */
export async function handleApiRuns(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/runs")) return null;

  // Round 5C1: explicit principal-auth gate. Fail closed on any missing or
  // wrong credential; never derive owner from the token; never accept an
  // ownerId from the client body.
  const auth = authenticatePrincipal(request, env);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  const ownerId = auth.principalId;

  // POST /api/runs
  if (path === "/api/runs" && method === "POST") {
    const idempotencyKey = request.headers.get("idempotency-key") || "";
    if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      return Response.json({ ok: false, error: "idempotency-key required" }, { status: 400 });
    }
    const body = await readJson(request);
    const task = typeof body?.task === "string" ? body.task : "";
    const spec = body?.spec && typeof body.spec === "object" ? body.spec : {};

    // Budget binding is required in production. Fail closed if missing.
    const budgetStub = budgetStubForPrincipal(env, ownerId);
    if (!budgetStub) {
      return Response.json({ ok: false, error: "budget binding missing" }, { status: 500 });
    }

    // Server-computed request hash (client cannot forge idempotency identity).
    const requestHash = await canonicalRequestHash({ task, spec });
    const limits = resolveBudgetLimits(env);
    const { estimatedTokens, estimatedCostMicros } = estimateBudgetFromTask(task, {
      maxOutputBytes: limits.maxOutputBytes,
    });
    const runId = mintRunId();

    // Reserve budget BEFORE calling RunControl admission. The budget DO
    // returns the CANONICAL runId — on idempotent retry that is the runId of
    // the original successful admission, not the freshly-minted one.
    const reserveRes = await budgetStub.fetch("https://do/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: ownerId,
        runId,
        idempotencyKey,
        requestHash,
        estimatedTokens,
        estimatedCostMicros,
        limits,
      }),
    });
    if (!reserveRes.ok) {
      // Bubble up conflict / limit errors verbatim.
      return reserveRes;
    }
    const reserveBody = await reserveRes.json();
    const admitRunId = reserveBody.runId;

    // Call RunControl with the mapped runId. If admission does not return
    // 202 we roll the active reservation back idempotently.
    const stub = doStubForRun(env, admitRunId);
    let res;
    try {
      res = await proxy(request, stub, "admit", "POST", { task, ownerId, spec, runId: admitRunId });
    } catch (err) {
      await releaseBudget(env, ownerId, admitRunId);
      throw err;
    }
    if (res.status !== 202) {
      await releaseBudget(env, ownerId, admitRunId);
      return res;
    }
    return res;
  }

  // /api/runs/:runId/...
  const m = path.match(/^\/api\/runs\/([^/]+)(?:\/(status|logs\/ref|logs|cancel))?$/);
  if (!m) return Response.json({ ok: false, error: "not found" }, { status: 404 });
  const [, runId, verb] = m;
  if (!RUN_ID_RE.test(runId)) {
    return Response.json({ ok: false, error: "invalid run id" }, { status: 400 });
  }
  const stub = doStubForRun(env, runId);

  if (verb === "status" && method === "GET") {
    // First drive finalization if terminal has landed on backend.
    // The DO handles idempotency; a status GET should not block on running work.
    const res = await proxy(request, stub, `status?ownerId=${encodeURIComponent(ownerId)}`, "GET");
    return normalizeNotFound(res);
  }
  if (verb === "logs" && method === "GET") {
    const res = await proxy(request, stub, `logs?ownerId=${encodeURIComponent(ownerId)}`, "GET");
    return normalizeNotFound(res);
  }
  if (verb === "logs/ref" && method === "GET") {
    const seqRaw = url.searchParams.get("seq") ?? "";
    if (!/^(0|[1-9]\d*)$/.test(seqRaw) || !Number.isSafeInteger(Number(seqRaw))) {
      return Response.json({ ok: false, error: "invalid seq" }, { status: 400 });
    }
    const res = await proxy(
      request,
      stub,
      `logs/ref?ownerId=${encodeURIComponent(ownerId)}&seq=${encodeURIComponent(seqRaw)}`,
      "GET",
    );
    return normalizeNotFound(res);
  }
  if (verb === "cancel" && method === "POST") {
    const res = await proxy(request, stub, "cancel", "POST", { ownerId });
    return normalizeNotFound(res);
  }
  return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
}
