// PrincipalBudgetDO — one Durable Object instance per principal.
//
// Round 5C1: strongly orders admission-critical writes under one SQL event
// path. Every operation is a single storage.sql event with NO awaits between
// the "check" and the "reserve" writes, so two concurrent reservations for
// the same principal cannot both pass the same budget check.
//
// Responsibilities:
//   1. Idempotent runId minting from (idempotencyKey, canonicalRequestHash).
//      Same key + same request => same runId. Same key + different request =>
//      409 conflict. This mapping is durable in SQL and survives DO restart.
//   2. Active reservation tracking (concurrent runs currently admitted for
//      this principal, not yet released).
//   3. Per-minute request count (sliding day-partitioned bucket).
//   4. Per-UTC-day run count.
//   5. Per-UTC-day estimated-token-day limit (server-computed, never from
//      client input).
//   6. Per-UTC-day estimated cost-micros-day limit.
//   7. Idempotent release: releasing a runId that isn't currently active
//      returns ok:true without decrementing below zero. Releasing a runId
//      that never reserved is a no-op.
//
// HTTP shape (internal — the API worker fronts this):
//   POST /reserve   { principalId, runId, idempotencyKey, requestHash,
//                     estimatedTokens, estimatedCostMicros, now? }
//   POST /release   { principalId, runId, now? }
//   GET  /snapshot  ?principalId=...             (test/debug only)
//
// Limits are provided by the caller from server env config. The DO does not
// read env directly for policy; the API worker resolves env => limits and
// passes them in so tests can inject overrides deterministically.

const SCHEMA_VERSION = 1;

/** Default fail-closed conservative limits. Every value MUST be positive.
 *  These are the "no env config" fallbacks — production overrides via the
 *  worker env. */
export const DEFAULT_BUDGET_LIMITS = Object.freeze({
  maxActiveReservations: 2,
  maxRequestsPerMinute: 12,
  maxRunsPerDay: 60,
  maxEstimatedTokensPerDay: 4_000_000,
  maxCostMicrosPerDay: 5_000_000, // 5 USD per day, expressed in micros
});

/** Server-side estimator: UTF-8 task bytes plus configured max-output bytes,
 *  never trusted from client. This is deterministic and cheap so admission
 *  cannot be delayed by a client-supplied number. */
export function estimateBudgetFromTask(task, { maxOutputBytes = 128 * 1024 } = {}) {
  const bytes = new TextEncoder().encode(String(task ?? "")).byteLength;
  // Rough char-to-token approximation: ~4 UTF-8 bytes per token. Rounded up.
  const estimatedTokens = Math.max(1, Math.ceil((bytes + maxOutputBytes) / 4));
  // Cost estimation: assume conservative $2 per million tokens (i.e. 2 micros
  // per token). This is intentionally coarse; the invariant is that the same
  // request always maps to the same cost estimate.
  const estimatedCostMicros = estimatedTokens * 2;
  return { estimatedTokens, estimatedCostMicros, taskBytes: bytes };
}

/** SQL-backed principal-budget store. All rows are keyed by principalId so
 *  the same DO instance safely handles a single principal (singleton-per-
 *  principal is enforced by the caller via idFromName(principalId)). */
class SqlBudgetStore {
  #sql;
  constructor(sql) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS budget_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`);
    sql.exec(`CREATE TABLE IF NOT EXISTS idempotency (
      idempotency_key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      run_id TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      estimated_cost_micros INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );`);
    sql.exec(`CREATE TABLE IF NOT EXISTS reservation (
      run_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      estimated_tokens INTEGER NOT NULL,
      estimated_cost_micros INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      released_at INTEGER
    );`);
    sql.exec(`CREATE TABLE IF NOT EXISTS minute_bucket (
      minute_ts INTEGER PRIMARY KEY,
      request_count INTEGER NOT NULL
    );`);
    sql.exec(`CREATE TABLE IF NOT EXISTS day_bucket (
      utc_day TEXT PRIMARY KEY,
      run_count INTEGER NOT NULL,
      tokens_estimated INTEGER NOT NULL,
      cost_micros_estimated INTEGER NOT NULL
    );`);
    // Bootstrap schema version for future migrations.
    const rs = sql.exec("SELECT value FROM budget_meta WHERE key = ?", "schema_version");
    const rows = rs.toArray ? rs.toArray() : [...rs];
    if (rows.length === 0) {
      sql.exec("INSERT INTO budget_meta (key, value) VALUES (?, ?)", "schema_version", String(SCHEMA_VERSION));
    }
  }
  #rows(rs) { return rs.toArray ? rs.toArray() : [...rs]; }

  bindPrincipal(principalId) {
    const rows = this.#rows(this.#sql.exec("SELECT value FROM budget_meta WHERE key = ?", "principal_id"));
    if (rows.length === 0) {
      this.#sql.exec("INSERT INTO budget_meta (key, value) VALUES (?, ?)", "principal_id", principalId);
      return true;
    }
    return rows[0].value === principalId;
  }
  findIdempotency(key) {
    const rows = this.#rows(this.#sql.exec("SELECT * FROM idempotency WHERE idempotency_key = ?", key));
    return rows[0] || null;
  }
  insertIdempotency(key, requestHash, runId, estimatedTokens, estimatedCostMicros, now) {
    this.#sql.exec(
      "INSERT INTO idempotency (idempotency_key, request_hash, run_id, estimated_tokens, estimated_cost_micros, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      key, requestHash, runId, estimatedTokens, estimatedCostMicros, now,
    );
  }
  activeReservationCount() {
    const rows = this.#rows(this.#sql.exec("SELECT COUNT(*) AS n FROM reservation WHERE released_at IS NULL"));
    return Number(rows[0]?.n || 0);
  }
  activeReservationForRun(runId) {
    const rows = this.#rows(this.#sql.exec("SELECT * FROM reservation WHERE run_id = ?", runId));
    return rows[0] || null;
  }
  insertReservation(runId, idempotencyKey, estimatedTokens, estimatedCostMicros, now) {
    this.#sql.exec(
      "INSERT INTO reservation (run_id, idempotency_key, estimated_tokens, estimated_cost_micros, created_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)",
      runId, idempotencyKey, estimatedTokens, estimatedCostMicros, now,
    );
  }
  markReleased(runId, now) {
    this.#sql.exec("UPDATE reservation SET released_at = ? WHERE run_id = ? AND released_at IS NULL", now, runId);
  }
  minuteBucket(minuteTs) {
    const rows = this.#rows(this.#sql.exec("SELECT request_count FROM minute_bucket WHERE minute_ts = ?", minuteTs));
    return Number(rows[0]?.request_count || 0);
  }
  bumpMinute(minuteTs) {
    const rows = this.#rows(this.#sql.exec("SELECT request_count FROM minute_bucket WHERE minute_ts = ?", minuteTs));
    if (rows.length === 0) {
      this.#sql.exec("INSERT INTO minute_bucket (minute_ts, request_count) VALUES (?, 1)", minuteTs);
    } else {
      this.#sql.exec("UPDATE minute_bucket SET request_count = request_count + 1 WHERE minute_ts = ?", minuteTs);
    }
  }
  dayBucket(day) {
    const rows = this.#rows(this.#sql.exec("SELECT run_count, tokens_estimated, cost_micros_estimated FROM day_bucket WHERE utc_day = ?", day));
    return rows[0] || { run_count: 0, tokens_estimated: 0, cost_micros_estimated: 0 };
  }
  bumpDay(day, tokens, costMicros) {
    const rows = this.#rows(this.#sql.exec("SELECT utc_day FROM day_bucket WHERE utc_day = ?", day));
    if (rows.length === 0) {
      this.#sql.exec(
        "INSERT INTO day_bucket (utc_day, run_count, tokens_estimated, cost_micros_estimated) VALUES (?, 1, ?, ?)",
        day, tokens, costMicros,
      );
    } else {
      this.#sql.exec(
        "UPDATE day_bucket SET run_count = run_count + 1, tokens_estimated = tokens_estimated + ?, cost_micros_estimated = cost_micros_estimated + ? WHERE utc_day = ?",
        tokens, costMicros, day,
      );
    }
  }
  snapshot(day, minuteTs) {
    return {
      schemaVersion: SCHEMA_VERSION,
      activeReservations: this.activeReservationCount(),
      minuteCount: this.minuteBucket(minuteTs),
      day: this.dayBucket(day),
    };
  }
}

function utcDay(now) { return new Date(now).toISOString().slice(0, 10); }
function utcMinute(now) { return Math.floor(now / 60_000); }

/** The Durable Object class. Singleton-per-principal enforced by binding
 *  callers using `idFromName(principalId)`.
 *
 *  Concurrency: every write path is a single synchronous SQL sequence.
 *  There is NO await between the "read counters" and the "write reservation"
 *  steps. This guarantees that if two /reserve calls land in the same DO
 *  instance the second will observe the first's writes. */
export class PrincipalBudgetDO {
  #state;
  #env;
  #store = null;

  constructor(state, env) {
    this.#state = state;
    this.#env = env || {};
  }

  #ensureStore() {
    if (this.#store) return this.#store;
    const sql = this.#state.storage?.sql;
    if (!sql) throw new Error("PrincipalBudgetDO requires state.storage.sql");
    this.#store = new SqlBudgetStore(sql);
    return this.#store;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === "/reserve" && method === "POST") {
        const body = await this.#readJson(request);
        return this.#handleReserve(body);
      }
      if (path === "/release" && method === "POST") {
        const body = await this.#readJson(request);
        return this.#handleRelease(body);
      }
      if (path === "/snapshot" && method === "GET") {
        return this.#handleSnapshot(url);
      }
      return Response.json({ ok: false, error: "not-found" }, { status: 404 });
    } catch (err) {
      return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
    }
  }

  async #readJson(request) {
    try { return await request.json(); } catch { return {}; }
  }

  /**
   * Strongly ordered reserve. One SQL event path; no await between check
   * and insert. All decisions and writes happen in the synchronous body.
   */
  #handleReserve(body) {
    const {
      principalId,
      runId,
      idempotencyKey,
      requestHash,
      estimatedTokens,
      estimatedCostMicros,
      limits: passedLimits,
      now: nowIn,
    } = body || {};

    if (!principalId || typeof principalId !== "string") {
      return Response.json({ ok: false, error: "missing-principal" }, { status: 400 });
    }
    if (!runId || typeof runId !== "string") {
      return Response.json({ ok: false, error: "missing-run-id" }, { status: 400 });
    }
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      return Response.json({ ok: false, error: "missing-idempotency-key" }, { status: 400 });
    }
    if (!requestHash || typeof requestHash !== "string") {
      return Response.json({ ok: false, error: "missing-request-hash" }, { status: 400 });
    }
    const tokens = Number.isFinite(estimatedTokens) ? Number(estimatedTokens) : NaN;
    const cost = Number.isFinite(estimatedCostMicros) ? Number(estimatedCostMicros) : NaN;
    if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(cost) || cost <= 0) {
      return Response.json({ ok: false, error: "invalid-estimate" }, { status: 400 });
    }

    // Enforcement policy comes only from this DO's server environment. Never
    // trust request-body limits, even on the internal binding.
    const limits = this.#env.__TERRARIUM_TEST_BUDGET_LIMITS__ === true
      ? { ...DEFAULT_BUDGET_LIMITS, ...(passedLimits || {}) }
      : resolveBudgetLimits(this.#env);
    const now = Number.isFinite(nowIn) ? Number(nowIn) : Date.now();
    const day = utcDay(now);
    const minute = utcMinute(now);
    const store = this.#ensureStore();

    // ---- Single SQL event path begins here. No awaits below. ----
    if (!store.bindPrincipal(principalId)) {
      return Response.json({ ok: false, error: "principal-mismatch" }, { status: 404 });
    }

    // 1. Idempotency check first: same key + same request hash returns the
    //    already-minted runId. Different request hash for same key => 409.
    const existingIdem = store.findIdempotency(idempotencyKey);
    if (existingIdem) {
      if (existingIdem.request_hash !== requestHash) {
        return Response.json({ ok: false, error: "idempotency-conflict" }, { status: 409 });
      }
      // Same key + same request: return the ORIGINAL runId. The active
      // reservation for that original runId is left as-is; if the caller
      // never observed the 202 the reservation is still valid.
      return Response.json({
        ok: true,
        idempotent: true,
        runId: existingIdem.run_id,
        estimatedTokens: existingIdem.estimated_tokens,
        estimatedCostMicros: existingIdem.estimated_cost_micros,
      });
    }

    // 2. Fresh reservation checks — all against limits.
    const activeCount = store.activeReservationCount();
    if (activeCount >= limits.maxActiveReservations) {
      return Response.json({ ok: false, error: "concurrency-limit" }, { status: 429 });
    }
    const minuteCount = store.minuteBucket(minute);
    if (minuteCount >= limits.maxRequestsPerMinute) {
      return Response.json({ ok: false, error: "minute-limit" }, { status: 429 });
    }
    const dayRow = store.dayBucket(day);
    if (Number(dayRow.run_count) >= limits.maxRunsPerDay) {
      return Response.json({ ok: false, error: "day-limit" }, { status: 429 });
    }
    if (Number(dayRow.tokens_estimated) + tokens > limits.maxEstimatedTokensPerDay) {
      return Response.json({ ok: false, error: "token-day-limit" }, { status: 429 });
    }
    if (Number(dayRow.cost_micros_estimated) + cost > limits.maxCostMicrosPerDay) {
      return Response.json({ ok: false, error: "cost-day-limit" }, { status: 429 });
    }

    // 3. Reserve — synchronous writes without any await in between.
    store.insertIdempotency(idempotencyKey, requestHash, runId, tokens, cost, now);
    store.insertReservation(runId, idempotencyKey, tokens, cost, now);
    store.bumpMinute(minute);
    store.bumpDay(day, tokens, cost);

    return Response.json({
      ok: true,
      idempotent: false,
      runId,
      estimatedTokens: tokens,
      estimatedCostMicros: cost,
    });
  }

  /**
   * Idempotent release. Releasing an already-released or unknown runId is a
   * no-op that still reports ok:true — terminal callbacks may replay and
   * must not corrupt counts.
   */
  #handleRelease(body) {
    const { principalId, runId, now: nowIn } = body || {};
    if (!principalId || typeof principalId !== "string") {
      return Response.json({ ok: false, error: "missing-principal" }, { status: 400 });
    }
    if (!runId || typeof runId !== "string") {
      return Response.json({ ok: false, error: "missing-run-id" }, { status: 400 });
    }
    const now = Number.isFinite(nowIn) ? Number(nowIn) : Date.now();
    const store = this.#ensureStore();
    if (!store.bindPrincipal(principalId)) {
      return Response.json({ ok: false, error: "principal-mismatch" }, { status: 404 });
    }
    const existing = store.activeReservationForRun(runId);
    if (!existing || existing.released_at != null) {
      // Idempotent: already released or never reserved. Never decrement below
      // zero. Report ok:true so callback retry does not treat repeated
      // releases as failure.
      return Response.json({ ok: true, released: false, idempotent: true });
    }
    store.markReleased(runId, now);
    return Response.json({ ok: true, released: true });
  }

  #handleSnapshot(url) {
    const principalId = url.searchParams.get("principalId");
    if (!principalId) return Response.json({ ok: false, error: "missing-principal" }, { status: 400 });
    const store = this.#ensureStore();
    if (!store.bindPrincipal(principalId)) {
      return Response.json({ ok: false, error: "principal-mismatch" }, { status: 404 });
    }
    const now = Date.now();
    return Response.json({ ok: true, snapshot: store.snapshot(utcDay(now), utcMinute(now)) });
  }
}

/** Compute canonical request hash for idempotency. Stable across whitespace
 *  differences in the top-level JSON encoding by walking the parsed object
 *  in a deterministic order. */
export async function canonicalRequestHash({ task, spec }) {
  const canonical = JSON.stringify({
    task: String(task ?? ""),
    spec: spec && typeof spec === "object" ? canonicalize(spec) : {},
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const k of keys) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

/** Read env-driven limits with fail-closed defaults. Any invalid config
 *  falls back to DEFAULT_BUDGET_LIMITS for that field — never lets a
 *  malformed number widen the budget. */
export function resolveBudgetLimits(env) {
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    maxActiveReservations: num(env?.TERRARIUM_BUDGET_MAX_ACTIVE, DEFAULT_BUDGET_LIMITS.maxActiveReservations),
    maxRequestsPerMinute: num(env?.TERRARIUM_BUDGET_MAX_PER_MINUTE, DEFAULT_BUDGET_LIMITS.maxRequestsPerMinute),
    maxRunsPerDay: num(env?.TERRARIUM_BUDGET_MAX_PER_DAY, DEFAULT_BUDGET_LIMITS.maxRunsPerDay),
    maxEstimatedTokensPerDay: num(env?.TERRARIUM_BUDGET_MAX_TOKENS_PER_DAY, DEFAULT_BUDGET_LIMITS.maxEstimatedTokensPerDay),
    maxCostMicrosPerDay: num(env?.TERRARIUM_BUDGET_MAX_COST_MICROS_PER_DAY, DEFAULT_BUDGET_LIMITS.maxCostMicrosPerDay),
    maxOutputBytes: num(env?.TERRARIUM_BUDGET_MAX_OUTPUT_BYTES, 128 * 1024),
  };
}

export const _testables = { SqlBudgetStore, SCHEMA_VERSION };
