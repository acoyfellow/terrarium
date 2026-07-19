// RunControlDO — one Durable Object instance per run.
//
// Responsibilities:
//   1. Persist the run contract (runId, taskFingerprint, nonce) and owner in SQL.
//   2. Hold durable intent (cancel/timeout, deadlineAt) so a lost cell can still
//      finalize purely from persisted state.
//   3. Persist execution reference (sandboxId + processId) so cancel/collect
//      can address the sandbox after DO restart with an empty JS heap.
//   4. Store bounded append-only log chunks in SQL. When logs exceed the SQL
//      budget the overflow is offloaded to R2 (TERRARIUM_ARTIFACTS) and only
//      an object ref is kept in SQL.
//   5. Persist terminal receipt state + terminal-callback event identity.
//   6. Emit exactly ONE canonical terminal callback into the durable pulse
//      journal AFTER the terminal state is committed. Retry via alarm() if
//      the callback fails to land.
//   7. Owner isolation on every read and mutation. Fail closed if any
//      production binding required for real execution is missing.
//   8. Idempotent admission: repeated POST /admit for the same runId returns
//      the original admission receipt (never launches a second child).
//
// The DO delegates classification (verified/inconclusive/failed/cancelled) to
// the shared `TerrariumRunCell` machinery so the local-cell test proofs port
// unchanged onto the production path.

import {
  TerrariumRunCell,
  LogArtifactStore,
  RunIndexStore,
  TerminalCallbackTransport,
  taskFingerprint,
} from "./local-run-cell.js";
import { evaluateAdmission, DEFAULT_ADMISSION_POLICY, normalizeCapabilityEnvelope } from "./admission.js";
import { tryCreateSandboxBackend } from "./sandbox-backend.js";

const RUN_ID_RE = /^ter_[A-Za-z0-9_]+$/;
const MAX_LOG_SQL_BYTES = 128 * 1024;       // per-run SQL log budget
const MAX_TASK_BYTES = 64 * 1024;           // admission gate for task text
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;  // 15 min default deadline
// Cold-start grace: a run may wait for a container to cold-boot (loading the
// pinned runtime) before its process is even launched. The task deadline is
// meant to bound EXECUTION, not queueing/boot, so we extend the durable
// deadline by a bounded startup grace. Overridable via env for capacity tuning.
// Without this, a burst of simultaneous cold boots consumes each run's deadline
// while it waits for a slot, deadline-killing healthy runs before they start.
const DEFAULT_STARTUP_GRACE_MS = 90 * 1000;
const CALLBACK_RETRY_MS = 30 * 1000;        // alarm retry cadence
const CALLBACK_MAX_ATTEMPTS = 10;
const SOFT_POLL_MS = 5 * 1000;              // alarm soft-poll cadence pre-deadline

/** Persistent SQL-backed durable store that mirrors RunStateStore's shape but
 *  survives DO restarts. Values are stored as JSON. Extended to record
 *  sandboxId/processId (execution address) and callback delivery state. */
class SqlRunStateStore {
  #sql;
  constructor(sql) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS run_state (
      run_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      contract TEXT NOT NULL,
      execution_ref TEXT NOT NULL,
      sandbox_id TEXT,
      process_id TEXT,
      status TEXT NOT NULL,
      intent TEXT,
      terminal TEXT,
      finalized INTEGER NOT NULL DEFAULT 0,
      capability_envelope TEXT,
      pid INTEGER,
      task TEXT NOT NULL,
      task_fingerprint TEXT NOT NULL,
      deadline_at INTEGER,
      created_at INTEGER NOT NULL,
      callback_committed INTEGER NOT NULL DEFAULT 0,
      callback_attempts INTEGER NOT NULL DEFAULT 0,
      callback_last_error TEXT,
      terminal_event TEXT
    );`);
    // Idempotent migration: add terminal_event to legacy row_state schemas
    // that were created before Round 5B. PRAGMA is used to detect columns.
    try {
      const info = sql.exec("PRAGMA table_info(run_state)");
      const rows = info.toArray ? info.toArray() : [...info];
      const hasCol = rows.some((r) => (r.name || r[1]) === "terminal_event");
      if (!hasCol) sql.exec("ALTER TABLE run_state ADD COLUMN terminal_event TEXT");
    } catch { /* older SQL shims may not support PRAGMA; new column exists in CREATE */ }
    sql.exec(`CREATE TABLE IF NOT EXISTS log_offload (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      r2_key TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      sha256 TEXT,
      PRIMARY KEY (run_id, seq)
    );`);
    // One authoritative migration site. Legacy refs keep a NULL digest and
    // therefore remain retrievable only as an explicit fail-closed error.
    const digestColumns = sql.exec("SELECT name FROM pragma_table_info('log_offload') WHERE name = 'sha256'");
    const digestRows = digestColumns.toArray ? digestColumns.toArray() : [...digestColumns];
    if (digestRows.length === 0) sql.exec("ALTER TABLE log_offload ADD COLUMN sha256 TEXT");
  }
  #row(runId) {
    const rs = this.#sql.exec("SELECT * FROM run_state WHERE run_id = ?", runId);
    const rows = rs.toArray ? rs.toArray() : [...rs];
    return rows[0] || null;
  }
  #fromRow(row) {
    if (!row) return null;
    return {
      runId: row.run_id,
      ownerId: row.owner_id,
      contract: JSON.parse(row.contract),
      executionRef: row.execution_ref,
      sandboxId: row.sandbox_id,
      processId: row.process_id,
      status: row.status,
      intent: row.intent,
      terminal: row.terminal ? JSON.parse(row.terminal) : null,
      finalized: !!row.finalized,
      capabilityEnvelope: row.capability_envelope ? JSON.parse(row.capability_envelope) : null,
      pid: row.pid,
      task: row.task,
      taskFingerprint: row.task_fingerprint,
      deadlineAt: row.deadline_at,
      createdAt: row.created_at,
      callbackCommitted: !!row.callback_committed,
      callbackAttempts: row.callback_attempts,
      callbackLastError: row.callback_last_error,
      terminalEvent: row.terminal_event ? JSON.parse(row.terminal_event) : null,
    };
  }
  create(runId, record) {
    if (this.#row(runId)) throw new Error(`run already exists: ${runId}`);
    this.#sql.exec(
      "INSERT INTO run_state (run_id, owner_id, contract, execution_ref, sandbox_id, process_id, status, intent, terminal, finalized, capability_envelope, pid, task, task_fingerprint, deadline_at, created_at, callback_committed, callback_attempts, callback_last_error) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?, ?, ?, 0, 0, NULL)",
      runId,
      record.ownerId,
      JSON.stringify(record.contract),
      record.executionRef,
      record.sandboxId ?? null,
      record.processId ?? null,
      record.status,
      record.capabilityEnvelope ? JSON.stringify(record.capabilityEnvelope) : null,
      record.pid ?? null,
      record.task,
      record.contract.taskFingerprint,
      record.deadlineAt ?? null,
      Date.now(),
    );
    return this.get(runId);
  }
  get(runId) { return this.#fromRow(this.#row(runId)); }
  has(runId) { return !!this.#row(runId); }
  patch(runId, patch) {
    const current = this.#fromRow(this.#row(runId));
    if (!current) throw new Error(`unknown run: ${runId}`);
    const next = { ...current, ...patch };
    this.#sql.exec(
      "UPDATE run_state SET status=?, intent=?, terminal=?, finalized=?, execution_ref=?, sandbox_id=?, process_id=?, deadline_at=?, callback_committed=?, callback_attempts=?, callback_last_error=?, terminal_event=? WHERE run_id=?",
      next.status,
      next.intent ?? null,
      next.terminal ? JSON.stringify(next.terminal) : null,
      next.finalized ? 1 : 0,
      next.executionRef,
      next.sandboxId ?? null,
      next.processId ?? null,
      next.deadlineAt ?? null,
      next.callbackCommitted ? 1 : 0,
      next.callbackAttempts ?? 0,
      next.callbackLastError ?? null,
      next.terminalEvent ? JSON.stringify(next.terminalEvent) : null,
      runId,
    );
    return next;
  }
  listUnfinalized() {
    const rs = this.#sql.exec("SELECT run_id FROM run_state WHERE finalized = 0");
    const rows = rs.toArray ? rs.toArray() : [...rs];
    return rows.map((r) => r.run_id);
  }
  listPendingCallback() {
    const rs = this.#sql.exec("SELECT run_id FROM run_state WHERE finalized = 1 AND callback_committed = 0 AND callback_attempts < ?", CALLBACK_MAX_ATTEMPTS);
    const rows = rs.toArray ? rs.toArray() : [...rs];
    return rows.map((r) => r.run_id);
  }
}

/** Bounded SQL log store with R2 overflow. Individual chunks are size-checked
 *  and the total is capped; overflow chunks are put into R2 with only a ref
 *  kept in SQL.
 *
 *  Round 5B.1:
 *   - `log_offload_seq` counter table allocates monotonic sequence numbers
 *     SYNCHRONOUSLY BEFORE any await, so two concurrent overflows cannot
 *     share the same seq / R2 key.
 *   - `#pending` tracks in-flight R2 puts per run; `flush(runId)` awaits all
 *     pending puts for that run and rethrows the first failure so the caller
 *     (LocalRunCell finalization) can classify infra failure. */
class SqlLogArtifactStore {
  #sql;
  #env;
  #waitUntil;   // anchors async R2 puts + ref-commit writes to the DO lifetime
  #logSqlBytes = MAX_LOG_SQL_BYTES;
  #encoder = new TextEncoder();
  #pending = new Map(); // runId -> Set<Promise>
  #failures = new Map(); // runId -> first settled offload failure (latched)
  constructor(sql, env = {}, { waitUntil } = {}) {
    this.#sql = sql;
    this.#env = env;
    this.#waitUntil = typeof waitUntil === "function" ? waitUntil : null;
    // Per-run SQL log budget. Overridable for qualification (e.g. forcing an R2
    // overflow with normal-sized output); defaults to the 128 KiB production
    // budget. Never trusted from a client — only from server env.
    const cap = Number(env?.TERRARIUM_LOG_SQL_BYTES);
    this.#logSqlBytes = Number.isInteger(cap) && cap > 0 ? cap : MAX_LOG_SQL_BYTES;
    sql.exec(`CREATE TABLE IF NOT EXISTS run_logs (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      chunk TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );`);
    // Monotonic per-run counter for R2 overflow sequence allocation.
    sql.exec(`CREATE TABLE IF NOT EXISTS log_offload_seq (
      run_id TEXT PRIMARY KEY,
      next_seq INTEGER NOT NULL
    );`);
    // Standalone test stores still need the current table shape. Schema
    // migration itself remains owned by SqlRunStateStore above.
    sql.exec(`CREATE TABLE IF NOT EXISTS log_offload (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      r2_key TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      sha256 TEXT,
      PRIMARY KEY (run_id, seq)
    );`);
  }
  /** UTF-8 byte total of all persisted chunks. LENGTH(CAST(x AS BLOB)) returns
   *  the byte-length of the encoded value, not code points, so multi-byte
   *  characters are correctly counted. */
  #currentBytes(runId) {
    const existing = this.#sql.exec("SELECT COALESCE(SUM(LENGTH(CAST(chunk AS BLOB))), 0) AS n FROM run_logs WHERE run_id = ?", runId);
    const rows = existing.toArray ? existing.toArray() : [...existing];
    return Number(rows[0]?.n || 0);
  }
  #nextSeq(runId) {
    const seqRs = this.#sql.exec("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM run_logs WHERE run_id = ?", runId);
    const seqRows = seqRs.toArray ? seqRs.toArray() : [...seqRs];
    return Number(seqRows[0]?.next || 0);
  }
  /** Split a JS string on a UTF-8 byte budget without breaking a multi-byte
   *  code point. Returns { head, tail } where |encodeUtf8(head)| <= budget. */
  #splitByUtf8Bytes(text, budget) {
    if (budget <= 0) return { head: "", tail: text };
    // Encode once, then walk back to the last full code point that fits.
    const encoded = this.#encoder.encode(text);
    if (encoded.byteLength <= budget) return { head: text, tail: "" };
    // Find the last byte index <= budget that is NOT a UTF-8 continuation byte
    // (top bits 10xxxxxx). This is a code-point boundary.
    let cut = budget;
    while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) cut -= 1;
    // Decode both halves fresh (avoid slicing at half a surrogate).
    const dec = new TextDecoder("utf-8", { fatal: false });
    const head = dec.decode(encoded.subarray(0, cut));
    const tail = dec.decode(encoded.subarray(cut));
    return { head, tail };
  }
  append(runId, chunk) {
    const text = String(chunk ?? "");
    if (!text) return;
    const already = this.#currentBytes(runId);
    if (already >= this.#logSqlBytes) {
      // Entirely over budget: overflow to R2, anchored to waitUntil so we
      // never lose an R2 put on eviction. Failures surface, not swallowed.
      // Round 5B.1: allocate seq SYNC before any await.
      const seq = this.#allocateOffloadSeq(runId);
      this.#anchor(runId, this.#offloadOverflow(runId, text, seq));
      return;
    }
    // Round 5B.1: RESERVE space for the overflow marker BEFORE splitting so
    // the inline total (head + marker) never exceeds MAX_LOG_SQL_BYTES. The
    // marker is only appended when there is genuine overflow, so also try a
    // no-marker split first: if the whole text fits without overflow, no
    // reservation is necessary.
    const room = this.#logSqlBytes - already;
    // First, try to fit without a marker. If it fits entirely, no overflow.
    const noMarker = this.#splitByUtf8Bytes(text, room);
    let inline = noMarker.head;
    let overflow = noMarker.tail;
    if (overflow) {
      // Overflow occurs — recompute with the marker byte cost reserved so the
      // inline row is guaranteed to stay within the 128 KiB budget.
      const MARKER = `\n[terrarium:log-overflow-to-r2]\n`;
      const markerBytes = this.#encoder.encode(MARKER).byteLength;
      if (markerBytes <= room) {
        const reserved = this.#splitByUtf8Bytes(text, room - markerBytes);
        inline = reserved.head + MARKER;
        overflow = reserved.tail;
      } else {
        // Less room remains than the marker itself. Keep the SQL byte cap
        // strict and offload this entire chunk rather than overrun the cap.
        inline = "";
        overflow = text;
      }
    }
    if (inline) {
      const next = this.#nextSeq(runId);
      this.#sql.exec("INSERT INTO run_logs (run_id, seq, chunk) VALUES (?, ?, ?)", runId, next, inline);
    }
    if (overflow) {
      // Round 5B.1: allocate the R2 seq SYNCHRONOUSLY (before await) via a
      // durable counter table so two concurrent overflows cannot share a key.
      const seq = this.#allocateOffloadSeq(runId);
      this.#anchor(runId, this.#offloadOverflow(runId, overflow, seq));
    }
  }
  #anchor(runId, promise) {
    // Attach every R2 put + ref-commit chain to state.waitUntil so an eviction
    // between put() and its ref-commit does not silently drop the artifact.
    // Do NOT `.catch(()=>{})` — the failure must propagate to observers.
    if (this.#waitUntil) {
      try { this.#waitUntil(promise); } catch { /* if waitUntil rejects, propagate below */ }
    }
    // Round 5B.1: track pending per-run so finalize() can await flush(runId)
    // and classify a persistence failure as infrastructure FAILED.
    if (runId != null) {
      let set = this.#pending.get(runId);
      if (!set) { set = new Set(); this.#pending.set(runId, set); }
      set.add(promise);
      promise.then(
        () => { set.delete(promise); },
        (error) => {
          if (!this.#failures.has(runId)) this.#failures.set(runId, error);
          set.delete(promise);
        },
      );
    }
    return promise;
  }
  /** Await all pending R2 puts for a run. If any failed, rethrows so the
   *  caller can classify as an infrastructure log-persistence failure. */
  async flush(runId) {
    const before = this.#failures.get(runId);
    if (before) throw before;
    const set = this.#pending.get(runId);
    if (set?.size) await Promise.allSettled([...set]);
    const after = this.#failures.get(runId);
    if (after) throw after;
  }
  async #offloadOverflow(runId, chunk, preAllocatedSeq) {
    const bucket = this.#env?.TERRARIUM_ARTIFACTS;
    if (!bucket || typeof bucket.put !== "function") {
      throw new Error("TERRARIUM_ARTIFACTS binding is required for log overflow");
    }
    // Round 5B.1: use the durable sync-allocated seq. If not provided (should
    // never happen from append() but keep safe), fall back to allocate here.
    const seq = preAllocatedSeq != null ? preAllocatedSeq : this.#allocateOffloadSeq(runId);
    const key = `runs/${runId}/logs/${String(seq).padStart(6, "0")}.log`;
    // Digest and count exactly the bytes written, not a later re-encoding.
    const bytes = this.#encoder.encode(chunk);
    const byteCount = bytes.byteLength;
    // Start the put synchronously so waitUntil observers can see it without
    // yielding; compute the digest concurrently over the same immutable bytes.
    const [sha256] = await Promise.all([sha256Hex(bytes), bucket.put(key, bytes)]);
    // Commit the ref only after R2 accepted the object.
    this.#sql.exec(
      "INSERT INTO log_offload (run_id, seq, r2_key, byte_count, sha256) VALUES (?, ?, ?, ?, ?)",
      runId, seq, key, byteCount, sha256,
    );
  }
  /** Round 5B.1: SYNCHRONOUS durable monotonic sequence allocation via a
   *  counter table. Runs before any await so two concurrent overflows cannot
   *  share a seq/key. UPSERT semantics: read current, write current+1. */
  #allocateOffloadSeq(runId) {
    const rs = this.#sql.exec("SELECT next_seq FROM log_offload_seq WHERE run_id = ?", runId);
    const rows = rs.toArray ? rs.toArray() : [...rs];
    const current = Number(rows[0]?.next_seq ?? 0);
    if (rows.length === 0) {
      this.#sql.exec("INSERT INTO log_offload_seq (run_id, next_seq) VALUES (?, ?)", runId, current + 1);
    } else {
      this.#sql.exec("UPDATE log_offload_seq SET next_seq = ? WHERE run_id = ?", current + 1, runId);
    }
    return current;
  }
  read(runId) {
    const rs = this.#sql.exec("SELECT chunk FROM run_logs WHERE run_id = ? ORDER BY seq ASC", runId);
    const rows = rs.toArray ? rs.toArray() : [...rs];
    return rows.map((r) => r.chunk).join("");
  }
  /** Full log tail for receipt validation. The TERRARIUM_RESULT line is always
   *  the final output, so if inline logs overflowed to R2 the receipt may live
   *  in the LAST overflow chunk. Return inline SQL logs plus the last verified
   *  overflow chunk's bytes so a valid receipt is never missed just because the
   *  run produced enough output to overflow. Integrity is enforced by readRef;
   *  a corrupt/missing overflow object falls back to inline logs (fail-closed:
   *  the receipt then reads as missing, never fabricated). */
  async readWithOverflow(runId) {
    const inline = this.read(runId);
    const refs = this.logRefs(runId);
    if (!refs.length) return inline;
    try {
      const last = refs[refs.length - 1];
      const { bytes } = await this.readRef(runId, last.seq);
      return inline + new TextDecoder().decode(bytes);
    } catch {
      return inline;
    }
  }
  logRefs(runId) {
    const rs = this.#sql.exec("SELECT seq, byte_count, sha256 FROM log_offload WHERE run_id = ? ORDER BY seq ASC", runId);
    const rows = rs.toArray ? rs.toArray() : [...rs];
    return rows.map((r) => ({ seq: r.seq, byteCount: r.byte_count, sha256: r.sha256 ?? null }));
  }
  async readRef(runId, seq) {
    const rs = this.#sql.exec(
      "SELECT seq, r2_key, byte_count, sha256 FROM log_offload WHERE run_id = ? AND seq = ?",
      runId, seq,
    );
    const rows = rs.toArray ? rs.toArray() : [...rs];
    const row = rows[0];
    if (!row) throw r2Error("R2_NOT_FOUND", 404);
    if (!row.sha256) throw r2Error("R2_UNVERIFIED_LEGACY", 502);
    const bucket = this.#env?.TERRARIUM_ARTIFACTS;
    if (!bucket || typeof bucket.get !== "function") throw r2Error("R2_UNAVAILABLE", 503);
    const object = await bucket.get(row.r2_key);
    if (!object) throw r2Error("R2_OBJECT_MISSING", 404);
    let bytes;
    if (object instanceof Uint8Array) {
      bytes = object;
    } else if (typeof object.arrayBuffer === "function") {
      bytes = new Uint8Array(await object.arrayBuffer());
    } else if (object.body) {
      bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    } else {
      throw r2Error("R2_CORRUPT", 502);
    }
    if (bytes.byteLength !== Number(row.byte_count)) throw r2Error("R2_CORRUPT", 502);
    if (await sha256Hex(bytes) !== row.sha256) throw r2Error("R2_CORRUPT", 502);
    return { seq: Number(row.seq), byteCount: Number(row.byte_count), sha256: row.sha256, bytes };
  }
}

function r2Error(code, status) {
  return Object.assign(new Error(code), { code, status });
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Bounded index of the runs owned by this DO instance (one row = this run). */
class SingletonRunIndexStore {
  #ownerId; #runId;
  set(ownerId, runId) { this.#ownerId = ownerId; this.#runId = runId; }
  add(ownerId, runId) { this.set(ownerId, runId); }
  list(ownerId) { return ownerId === this.#ownerId && this.#runId ? [this.#runId] : []; }
}

/** In-memory transport wrapper that ALSO forwards the emitted terminal event
 *  to the caller-provided `emitToPulse` hook so the canonical pulse journal
 *  gets exactly one terminal callback per run AFTER the terminal state has
 *  been committed. The emit result (ok/err) is reported so the DO can retry
 *  via alarm() until success or attempt-cap. */
class CommittingCallbackTransport extends TerminalCallbackTransport {
  #emitToPulse;
  #persistEvent; // synchronous: writes terminal_event to durable SQL
  #loadEvent;    // synchronous: reads terminal_event back from SQL (post-restart)
  #waitUntil;    // anchors the first send so an eviction cannot drop it
  constructor({ emitToPulse, persistEvent, loadEvent, waitUntil } = {}) {
    super();
    this.#emitToPulse = emitToPulse;
    this.#persistEvent = persistEvent;
    this.#loadEvent = loadEvent;
    this.#waitUntil = waitUntil;
  }
  queue(event) {
    // Round 5B.1: SYNCHRONOUSLY persist canonical terminal event BEFORE first
    // send. Never catch a persistence failure — a restart between queue() and
    // emit MUST know exactly which event to retry, and swallowing this failure
    // silently loses the callback. If persistEvent throws, propagate.
    if (this.#persistEvent && event) {
      // Injected persistEvent is contract-bound to patch event.runId; that
      // patch propagates naturally because `event` is the same object.
      this.#persistEvent(event);
    }
    const res = super.queue(event);
    if (this.#emitToPulse) {
      const p = Promise.resolve().then(() => this.#emitToPulse(event));
      // Anchor with state.waitUntil so the DO is not evicted mid-send.
      if (this.#waitUntil) {
        try { this.#waitUntil(p); } catch { /* runtime rejected anchor — retry via alarm */ }
      }
      // Do NOT mutate the persisted event with __lastError. The emitToPulse
      // hook itself records callbackLastError durably on failure; a second
      // persistEvent write here would corrupt the retry event body.
      p.catch(() => { /* observed via callbackLastError; alarm retries */ });
    }
    return res;
  }
  /** Retry the last emit — called by the DO alarm when callbackCommitted is
   *  false. Loads the event from durable SQL, so a completely fresh DO/backend
   *  object (empty JS heap) still retries the correct event.
   *  Idempotent downstream because the eventId is stable. */
  async retryLastEmit() {
    if (!this.#emitToPulse) return false;
    let event = null;
    if (this.#loadEvent) {
      try { event = this.#loadEvent(); } catch { event = null; }
    }
    if (!event) return false;
    return await this.#emitToPulse(event);
  }
}

/** The Durable Object class for a single run.
 *
 *  HTTP shape (internal — the worker fronts this):
 *    POST /admit      { task, ownerId, spec?, runId? }        -> 202 { runId, contract }
 *    GET  /status?ownerId=...
 *    GET  /logs?ownerId=...
 *    POST /cancel     { ownerId }
 *    POST /collect    { ownerId }
 *    POST /reconcile  { }                                     -> alarm/self-heal path */
export class RunControlDO {
  #state;
  #env;
  #cell = null;
  #initPromise = null;
  #runId = null;
  #runState = null;
  #logs = null;
  #backend = null;

  constructor(state, env) {
    this.#state = state;
    this.#env = env || {};
  }

  async #ensureCell() {
    if (this.#cell) return this.#cell;
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = (async () => {
      const sql = this.#state.storage?.sql;
      if (!sql) throw new Error("RunControlDO requires state.storage.sql");
      const runState = new SqlRunStateStore(sql);
      const waitUntil = (p) => { try { this.#state.waitUntil?.(p); } catch { /* runtime may reject after eviction */ } };
      const logs = new SqlLogArtifactStore(sql, this.#env, { waitUntil });
      const index = new SingletonRunIndexStore();
      // Fail closed: production requires a real sandbox backend, but tests
      // may inject __TERRARIUM_TEST_BACKEND__. The fake SandboxContainerBackend
      // spike from backend-adapter.js is NOT accepted here.
      const backend = (await tryCreateSandboxBackend(this.#env))
        || this.#env.__TERRARIUM_TEST_BACKEND__;
      if (!backend) {
        throw Object.assign(
          new Error("RunControlDO requires a real sandbox backend (TERRARIUM_SANDBOX binding missing)"),
          { code: "MISSING_BACKEND", status: 500 },
        );
      }
      const callbacks = new CommittingCallbackTransport({
        waitUntil,
        // Synchronously persist the queued terminal event to durable SQL so a
        // fresh DO/backend object after full eviction can reload the exact
        // event and retry — never depend on in-memory #lastEvent.
        persistEvent: (event) => {
          if (!event?.runId || event.runId !== this.#runId) {
            throw new Error("terminal callback event does not match the active run");
          }
          this.#runState.patch(event.runId, { terminalEvent: event });
        },
        loadEvent: () => {
          if (!this.#runId) return null;
          try { return this.#runState.get(this.#runId)?.terminalEvent || null; } catch { return null; }
        },
        emitToPulse: async (event) => {
          const delivered = await this.#emitToPulse(event);
          let committed = delivered;
          if (this.#runId) {
            try {
              this.#runState.patch(this.#runId, {
                callbackCommitted: delivered,
                callbackAttempts: (this.#runState.get(this.#runId)?.callbackAttempts || 0) + 1,
                callbackLastError: delivered ? null : "emit-failed",
              });
            } catch {
              // Delivery without a durable commit must be retried with the
              // stable eventId; downstream dedup makes that safe.
              committed = false;
            }
          }
          if (!committed) {
            try { await this.#scheduleAlarm(Date.now() + CALLBACK_RETRY_MS); } catch { /* ignore */ }
          }
          return committed;
        },
      });
      this.#runState = runState;
      this.#logs = logs;
      this.#backend = backend;
      this.#cell = new TerrariumRunCell({
        state: runState,
        logs,
        index,
        callbacks,
        backend,
      });
      // Restart recovery: adopt any pre-existing runId from durable state.
      const existing = runState.listUnfinalized();
      if (existing.length > 0) {
        this.#runId = existing[0];
        // Anchor reattach work with state.waitUntil so an eviction between
        // ensureCell() and the reattach body does not lose durable wiring.
        waitUntil(this.#reattachExecution(this.#runId));
        // Also make sure an alarm is armed to drive terminal collection.
        try { await this.#scheduleAlarm(Date.now() + 1000); } catch { /* ignore */ }
      } else {
        // Even if finalized, adopt the runId so status/logs work.
        const pending = runState.listPendingCallback();
        if (pending.length > 0) this.#runId = pending[0];
        else {
          // Try to find any existing runId.
          const rs = sql.exec("SELECT run_id FROM run_state LIMIT 1");
          const rows = rs.toArray ? rs.toArray() : [...rs];
          if (rows[0]) this.#runId = rows[0].run_id;
        }
      }
      return this.#cell;
    })();
    return this.#initPromise;
  }

  async #reattachExecution(runId) {
    if (!this.#runState || !this.#backend) return;
    const row = this.#runState.get(runId);
    if (!row || row.finalized) return;
    // Fail closed: reattach requires BOTH sandboxId AND processId. Without a
    // deterministic process address we cannot cancel/poll/kill after restart.
    if (!row.sandboxId || !row.processId) {
      try {
        this.#runState.patch(runId, {
          intent: row.intent || "cancel",
          callbackLastError: "reattach-missing-execution-address",
        });
      } catch { /* propagate via alarm */ }
      return;
    }
    if (typeof this.#backend.reattach === "function") {
      try {
        this.#backend.reattach({
          executionRef: row.executionRef,
          sandboxId: row.sandboxId,
          processId: row.processId,
          contract: row.contract,
          task: row.task ?? null,
          deadlineMs: row.deadlineAt ? Math.max(0, row.deadlineAt - Date.now()) : null,
        });
      } catch { /* durable state remains; alarm can retry */ }
    }
  }

  async #scheduleAlarm(atMs) {
    try {
      const storage = this.#state.storage;
      if (!storage || typeof storage.setAlarm !== "function") return;
      const cur = typeof storage.getAlarm === "function" ? await storage.getAlarm() : null;
      if (!cur || cur > atMs) await storage.setAlarm(atMs);
    } catch { /* ignore */ }
  }

  /** Cloudflare Workers alarm entrypoint. Drives:
   *   1. Deadline enforcement (timeout via backend if deadline crossed).
   *   2. Terminal collection if the child has exited but not been finalized.
   *   3. Callback retry if the terminal callback has not been committed. */
  async alarm() {
    try {
      await this.#ensureCell();
    } catch {
      return; // no backend available; nothing to do
    }
    if (!this.#runId) return;
    const row = this.#runState.get(this.#runId);
    if (!row) return;

    if (!row.finalized) {
      const now = Date.now();
      const predeadline = !row.deadlineAt || now < row.deadlineAt;
      // Before the deadline: soft-poll process state via a deterministic
      // process address. If still running, missing, or throwing, RE-ARM and
      // RETURN — do NOT await cell.collect (which would hang on waitExit).
      // Round 5B.1: collect is only reached when poll EXPLICITLY reports
      // terminal:true. Missing/throwing poll => re-arm and return.
      if (predeadline) {
        if (typeof this.#backend?.poll !== "function") {
          // No poll => cannot confirm terminal; re-arm to soft-poll cadence.
          const next = Math.min(row.deadlineAt || (now + SOFT_POLL_MS), now + SOFT_POLL_MS);
          await this.#scheduleAlarm(next);
          return;
        }
        let terminalPoll = false;
        try {
          const s = await this.#backend.poll(row.executionRef);
          terminalPoll = !!(s && s.terminal === true);
        } catch {
          // Poll threw: never speculatively collect. Re-arm and return.
          const next = Math.min(row.deadlineAt || (now + SOFT_POLL_MS), now + SOFT_POLL_MS);
          await this.#scheduleAlarm(next);
          return;
        }
        if (!terminalPoll) {
          const next = Math.min(row.deadlineAt || (now + SOFT_POLL_MS), now + SOFT_POLL_MS);
          await this.#scheduleAlarm(next);
          return;
        }
        // Terminal poll: safe to collect (waitExit will resolve promptly).
        try { await this.#cell.collect(this.#runId); } catch { /* alarm survives */ }
      } else {
        // At/after deadline: record timeout intent, retry the kill at the
        // deterministic process address, and collect only once poll is
        // terminal. Never wait for waitExit here; that would hang the alarm.
        // Round 5B.1: anchor the timeout kill promise with waitUntil; a failed
        // first kill leaves waitExit unsettled and the next alarm retries.
        try { this.#runState.patch(this.#runId, { intent: "timeout" }); } catch { /* ignore */ }
        if (typeof this.#backend?.timeout === "function") {
          try {
            const killResult = this.#backend.timeout(row.executionRef);
            if (killResult && typeof killResult.then === "function") {
              try { this.#state.waitUntil?.(Promise.resolve(killResult).catch(() => {})); } catch { /* ignore */ }
            }
          } catch { /* retry next alarm */ }
        }
        // Collection always requires an explicit substrate terminal signal.
        // A missing/throwing poll cannot prove the process is dead.
        let terminalPoll = false;
        if (typeof this.#backend?.poll === "function") {
          try {
            const s = await this.#backend.poll(row.executionRef);
            terminalPoll = !!(s && s.terminal === true);
          } catch { terminalPoll = false; }
        }
        if (terminalPoll) {
          try { await this.#cell.collect(this.#runId); } catch { /* survive */ }
        } else {
          // Kill did not confirm terminal — re-arm for another attempt.
          await this.#scheduleAlarm(Date.now() + SOFT_POLL_MS);
          return;
        }
      }
    }

    // Callback retry works for finalized rows even after a completely fresh
    // DO/backend object — retryLastEmit loads the event from durable SQL.
    const cur = this.#runState.get(this.#runId);
    if (cur?.finalized && !cur.callbackCommitted && cur.callbackAttempts < CALLBACK_MAX_ATTEMPTS) {
      const transport = this.#cell?.callbacks;
      if (transport && typeof transport.retryLastEmit === "function") {
        let retried = false;
        try { retried = await transport.retryLastEmit(); } catch { /* alarm re-arms below */ }
        // A terminal commit may have crashed before terminal_event persisted.
        // Reconcile reconstructs the canonical event from durable terminal state.
        if (!retried) {
          try { this.#cell.reconcile(this.#runId); } catch { /* alarm re-arms below */ }
        }
      } else {
        try { this.#cell.reconcile(this.#runId); } catch { /* ignore */ }
      }
      const after = this.#runState.get(this.#runId);
      if (after && !after.callbackCommitted) {
        await this.#scheduleAlarm(Date.now() + CALLBACK_RETRY_MS);
      }
    }
  }

  async #emitToPulse(event) {
    // Round 5C1: release the principal reservation idempotently ALONGSIDE
    // the Pulse emit. The release path is fire-and-forget-idempotent — if
    // it fails the next callback retry will attempt it again. Release does
    // not gate receipt authority: the receipt is the authoritative record
    // regardless of whether the budget release lands on the first attempt.
    // Runs launched via the internal DO-only path (no principal in the
    // durable row) have no reservation to release and skip this step.
    let reservationReleased = false;
    try {
      reservationReleased = await this.#releasePrincipalReservation(event);
    } catch { /* combined result remains uncommitted; callback alarm retries */ }

    const routerBinding = this.#env.PULSE_ROUTER;
    if (!routerBinding || typeof routerBinding.get !== "function") return false;
    try {
      const stub = routerBinding.get(routerBinding.idFromName("global"));
      // Round 5C2: the internal terminal callback carries the durable row's
      // ownerId (== the principalId for principal-auth admits) as event.ownerId.
      // No token is involved: this is a DO->DO call inside one trusted worker.
      // The Pulse DO still requires and validates ownerId for this production
      // route; missing or malformed durable ownership must fail closed.
      const row = this.#runState?.get?.(event.runId) || null;
      const ownerId = row?.ownerId ?? event.ownerId ?? null;
      const routeArgs = {
        event: {
          type: event.status === "done" ? "Completed" : (event.status === "cancelled" ? "Cancelled" : "Failed"),
          eventId: event.eventId,
          runId: event.runId,
          status: event.status,
          ok: !!event.ok,
          at: new Date().toISOString(),
          ...(ownerId ? { ownerId } : {}),
        },
      };
      const res = await stub.fetch("https://pulse-do/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "route", args: routeArgs, requirePrincipalOwner: true }),
      });
      return reservationReleased && !!res && res.ok !== false;
    } catch {
      return false;
    }
  }

  async #releasePrincipalReservation(event) {
    const runId = event?.runId;
    if (!runId) return false;
    const row = this.#runState?.get?.(runId);
    // ownerId in the durable row is the principalId for principal-auth
    // admits. For DO-only test paths there is no PrincipalBudget binding
    // and this returns early.
    const principalId = row?.ownerId;
    const ns = this.#env?.TERRARIUM_PRINCIPAL_BUDGET;
    // Internal/unit paths without a configured budget binding have no
    // reservation to release. A configured binding, however, must confirm.
    if (!ns) return true;
    if (!principalId || typeof ns.idFromName !== "function") return false;
    const stub = ns.get(ns.idFromName(principalId));
    try {
      const res = await stub.fetch("https://do/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId, runId }),
      });
      return !!res?.ok;
    } catch {
      return false;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const body = method === "POST" ? await this.#readJson(request) : {};

    try {
      if (path === "/admit" && method === "POST") return await this.#handleAdmit(body);
      if (path === "/status" && method === "GET") return await this.#handleStatus(url.searchParams.get("ownerId"));
      if (path === "/graded" && method === "GET") return await this.#handleGraded(url.searchParams.get("ownerId"));
      if (path === "/logs" && method === "GET") return await this.#handleLogs(url.searchParams.get("ownerId"));
      if (path === "/logs/ref" && method === "GET") return await this.#handleLogsRef(url.searchParams.get("ownerId"), url.searchParams.get("seq"));
      if (path === "/cancel" && method === "POST") return await this.#handleCancel(body);
      if (path === "/collect" && method === "POST") return await this.#handleCollect(body);
      if (path === "/reconcile" && method === "POST") return await this.#handleReconcile();
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    } catch (err) {
      const status = err?.status || 500;
      return Response.json({ ok: false, error: err?.message || String(err) }, { status });
    }
  }

  async #readJson(request) {
    try { return await request.json(); } catch { return {}; }
  }

  async #handleAdmit(body) {
    const { task, ownerId, spec = {}, runId } = body || {};
    const verdict = evaluateAdmission({ task, ownerId }, { ...DEFAULT_ADMISSION_POLICY, maxTaskBytes: MAX_TASK_BYTES }, 0);
    if (!verdict.ok) return Response.json({ admitted: false, reason: verdict.reason }, { status: verdict.status });

    const cell = await this.#ensureCell();

    // Idempotent admission: repeat call for the same (runId, task fingerprint)
    // returns the original admission receipt. Different runId with the same DO
    // is a client bug: we refuse the second admission.
    if (this.#runId) {
      const existing = this.#runState.get(this.#runId);
      const fp = taskFingerprint(task);
      if (existing && (!runId || runId === existing.runId) && existing.taskFingerprint === fp && existing.ownerId === ownerId) {
        // Round 5B.1: an idempotent retry against an addressless row (durable
        // sandboxId/processId missing) MUST fail. Test backends can bypass
        // this via __TERRARIUM_TEST_ALLOW_ADDRESSLESS__.
        const allowAddressless = !!this.#env.__TERRARIUM_TEST_ALLOW_ADDRESSLESS__;
        if (!allowAddressless && (!existing.sandboxId || !existing.processId)) {
          return Response.json({
            admitted: false,
            reason: "admission-address-missing",
          }, { status: 500 });
        }
        return Response.json({
          admitted: true,
          idempotent: true,
          runId: existing.runId,
          contract: existing.contract,
          executionRef: existing.executionRef,
        }, { status: 202 });
      }
      return Response.json({ admitted: false, reason: "run-cell-already-populated" }, { status: 409 });
    }

    const capabilityEnvelope = normalizeCapabilityEnvelope(spec.capabilityEnvelope);
    const deadlineMs = Number.isFinite(spec.deadlineMs) ? Number(spec.deadlineMs) : DEFAULT_TIMEOUT_MS;
    // Add a bounded startup grace so container cold-boot/queue time does not eat
    // the caller's execution budget. The grace is a server knob, never client
    // controlled, and is clamped so it cannot extend a run indefinitely.
    const graceEnv = Number(this.#env?.TERRARIUM_STARTUP_GRACE_MS);
    const startupGraceMs = Number.isFinite(graceEnv) && graceEnv >= 0
      ? Math.min(graceEnv, 10 * 60 * 1000)
      : DEFAULT_STARTUP_GRACE_MS;
    const boundedDeadlineMs = Math.max(1000, Math.min(deadlineMs, 60 * 60 * 1000));
    const deadlineAt = Date.now() + boundedDeadlineMs + startupGraceMs;
    const launched = cell.launch({
      task,
      ownerId,
      ...(runId && RUN_ID_RE.test(runId) ? { runId } : {}),
      spec: { ...spec, task, capabilityEnvelope, deadlineMs },
    });
    this.#runId = launched.runId;

    // Round 5B.1: SYNCHRONOUSLY persist BOTH sandboxId AND processId along
    // with the deadline. If either is missing OR the durable patch throws,
    // the admission MUST NOT return 202: signal cancel to the backend, anchor
    // the kill promise with waitUntil, and fail. A retry with the same runId
    // whose row is still addressless must ALSO fail. Test backends may retain
    // compatibility only when explicitly injected via
    // __TERRARIUM_TEST_ALLOW_ADDRESSLESS__.
    let sandboxId = null;
    let processId = null;
    let patchError = null;
    try {
      // __TERRARIUM_TEST_BLOCK_ADDRESS__ simulates a backend that cannot
      // provide a deterministic process address; admission must fail closed.
      const blockAddress = !!this.#env.__TERRARIUM_TEST_BLOCK_ADDRESS__;
      const startedMeta = (!blockAddress && typeof this.#backend?.describe === "function")
        ? this.#backend.describe(launched.executionRef)
        : null;
      sandboxId = startedMeta?.sandboxId || launched.sandboxId || null;
      processId = startedMeta?.processId || launched.processId || null;
      this.#runState.patch(launched.runId, {
        deadlineAt,
        sandboxId,
        processId,
      });
    } catch (err) {
      patchError = err;
    }
    const allowAddressless = !!this.#env.__TERRARIUM_TEST_ALLOW_ADDRESSLESS__;
    const addressMissing = !sandboxId || !processId;
    if ((patchError || addressMissing) && !allowAddressless) {
      // Fail closed: signal cancel and anchor the kill promise so the running
      // child is torn down even though admission failed. Mark the durable row
      // so a subsequent idempotent retry with the same runId also fails.
      try {
        const killResult = this.#backend?.cancel?.(launched.executionRef);
        if (killResult && typeof killResult.then === "function") {
          this.#state.waitUntil?.(Promise.resolve(killResult).catch(() => {}));
        }
      } catch { /* ignore — the child dies with the sandbox */ }
      try {
        this.#runState.patch(launched.runId, {
          intent: "cancel",
          status: "failed",
          terminal: { status: "failed", ok: false, reason: "admission-address-missing" },
          finalized: true,
          callbackLastError: "admission-address-missing",
        });
      } catch { /* best-effort */ }
      return Response.json({
        admitted: false,
        reason: patchError ? "admission-patch-failed" : "admission-address-missing",
      }, { status: 500 });
    }

    // Arm an alarm at the deadline and a short soft-collect alarm.
    await this.#scheduleAlarm(Math.min(deadlineAt, Date.now() + 5 * 1000));

    // Schedule soft finalization inline.
    this.#state.waitUntil?.(this.#driveToTerminal(launched.runId, ownerId));

    return Response.json({
      admitted: true,
      runId: launched.runId,
      contract: launched.contract,
      executionRef: launched.executionRef,
    }, { status: 202 });
  }

  async #driveToTerminal(runId, ownerId) {
    try {
      const cell = await this.#ensureCell();
      await cell.collect(runId);
    } catch {
      /* persisted-state driven recovery is available via /collect and alarm() */
    }
  }

  async #handleStatus(ownerId) {
    if (!ownerId) return Response.json({ ok: false, error: "missing-owner" }, { status: 401 });
    await this.#ensureCell();
    if (!this.#runId) return Response.json({ ok: false, error: "no-run" }, { status: 404 });
    try {
      const st = this.#cell.status(this.#runId, ownerId);
      return Response.json({ ok: true, status: st });
    } catch (err) {
      const code = err?.code === "EACCES" ? 403 : (err?.code === "ENOENT" ? 404 : 500);
      return Response.json({ ok: false, error: err.message }, { status: code });
    }
  }

  // Read-only graded view: composes the authoritative terminal with an ADVISORY
  // trust grade + content-addressed artifact. Never mutates the run. The nonce
  // stays inside the DO trust boundary; only the content-addressed artifact
  // (whose id is the hash of a body that includes the triple) leaves. No
  // correctness annotation is attached here (single-run cell has one attempt);
  // callers compose cross-model correctness above this layer.
  async #handleGraded(ownerId) {
    if (!ownerId) return Response.json({ ok: false, error: "missing-owner" }, { status: 401 });
    await this.#ensureCell();
    if (!this.#runId) return Response.json({ ok: false, error: "no-run" }, { status: 404 });
    try {
      const st = this.#cell.status(this.#runId, ownerId);
      if (!st.terminal) return Response.json({ ok: true, runId: this.#runId, graded: null, reason: "not-terminal" });
      const row = this.#runState.get(this.#runId);
      const contract = row?.contract;
      if (!contract?.runId || !contract?.taskFingerprint || !contract?.nonce) {
        return Response.json({ ok: false, error: "contract-unavailable" }, { status: 500 });
      }
      const { buildGradedReceipt } = await import("./graded-receipt.js");
      const built = await buildGradedReceipt({ contract, terminal: st.terminal, correctness: null });
      // Do not echo the nonce in the response envelope; it is embedded only in
      // the content-addressed artifact body (already public-by-design there).
      return Response.json({ ok: true, runId: this.#runId, grade: built.grade, artifact: built.artifact });
    } catch (err) {
      const code = err?.code === "EACCES" ? 403 : (err?.code === "ENOENT" ? 404 : 500);
      return Response.json({ ok: false, error: err.message }, { status: code });
    }
  }

  async #handleLogs(ownerId) {
    if (!ownerId) return Response.json({ ok: false, error: "missing-owner" }, { status: 401 });
    await this.#ensureCell();
    if (!this.#runId) return Response.json({ ok: false, error: "no-run" }, { status: 404 });
    try {
      this.#cell.status(this.#runId, ownerId);
      return Response.json({
        ok: true,
        runId: this.#runId,
        logs: this.#cell.logs(this.#runId),
        logRefs: typeof this.#logs.logRefs === "function" ? this.#logs.logRefs(this.#runId) : [],
      });
    } catch (err) {
      const code = err?.code === "EACCES" ? 403 : 404;
      return Response.json({ ok: false, error: err.message }, { status: code });
    }
  }

  async #handleLogsRef(ownerId, seqRaw) {
    if (!ownerId) return Response.json({ ok: false, error: "missing-owner" }, { status: 401 });
    await this.#ensureCell();
    if (!this.#runId) return Response.json({ ok: false, error: "not found" }, { status: 404 });
    try {
      this.#cell.status(this.#runId, ownerId);
    } catch (error) {
      const status = error?.code === "EACCES" ? 403 : 404;
      return Response.json({ ok: false, error: "not found" }, { status });
    }
    if (!/^(0|[1-9]\d*)$/.test(String(seqRaw ?? "")) || !Number.isSafeInteger(Number(seqRaw))) {
      return Response.json({ ok: false, error: "invalid-seq" }, { status: 400 });
    }
    try {
      const ref = await this.#logs.readRef(this.#runId, Number(seqRaw));
      return new Response(ref.bytes, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(ref.byteCount),
          "x-terrarium-log-seq": String(ref.seq),
          "x-terrarium-log-byte-count": String(ref.byteCount),
          "x-terrarium-log-sha256": ref.sha256,
        },
      });
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "R2_ERROR";
      const status = Number.isInteger(error?.status) ? error.status : 502;
      return Response.json({ ok: false, code }, { status });
    }
  }

  async #handleCancel(body) {
    const { ownerId } = body || {};
    if (!ownerId) return Response.json({ ok: false, error: "missing-owner" }, { status: 401 });
    await this.#ensureCell();
    if (!this.#runId) return Response.json({ ok: false, error: "no-run" }, { status: 404 });
    let runStatus;
    try {
      runStatus = this.#cell.status(this.#runId, ownerId);
    } catch (err) {
      const code = err?.code === "EACCES" ? 403 : 404;
      return Response.json({ ok: false, error: err.message }, { status: code });
    }
    // Round 5B.1: anchor the kill promise with waitUntil so the DO cannot be
    // evicted before killProcess confirms. Failed kill leaves waitExit
    // unsettled; alarm() retries via poll + timeout/cancel.
    // Cancel is idempotent. If the run already reached terminal (its execution
    // was evicted from the cell), cancel() returns { alreadyTerminal } instead of
    // throwing `unknown executionRef` — return an already-terminal result, not a
    // 500 (issue #18).
    const killResult = this.#cell.cancel(this.#runId);
    if (killResult && killResult.alreadyTerminal) {
      return Response.json({ ok: true, cancelled: false, alreadyTerminal: true, status: runStatus?.status ?? "terminal" });
    }
    this.#state.waitUntil?.(Promise.resolve(killResult).catch(() => {}));
    // Only drive to terminal after we have some proof of settlement.
    this.#state.waitUntil?.(this.#driveToTerminal(this.#runId, ownerId));
    // Ensure an alarm is armed to retry kill if the first attempt failed.
    try { await this.#scheduleAlarm(Date.now() + SOFT_POLL_MS); } catch { /* ignore */ }
    return Response.json({ ok: true, cancelled: true });
  }

  async #handleCollect(body) {
    const { ownerId } = body || {};
    if (!ownerId) return Response.json({ ok: false, error: "missing-owner" }, { status: 401 });
    await this.#ensureCell();
    if (!this.#runId) return Response.json({ ok: false, error: "no-run" }, { status: 404 });
    try {
      this.#cell.status(this.#runId, ownerId);
    } catch (err) {
      const code = err?.code === "EACCES" ? 403 : 404;
      return Response.json({ ok: false, error: err.message }, { status: code });
    }
    const terminal = await this.#cell.collect(this.#runId);
    return Response.json({ ok: true, terminal });
  }

  async #handleReconcile() {
    await this.#ensureCell();
    if (!this.#runId) return Response.json({ ok: true, repaired: false, reason: "no-run" });
    const res = this.#cell.reconcile(this.#runId);
    return Response.json({ ok: true, ...res });
  }
}

export const _testables = {
  SqlRunStateStore,
  SqlLogArtifactStore,
  CommittingCallbackTransport,
  MAX_LOG_SQL_BYTES,
  MAX_TASK_BYTES,
  DEFAULT_TIMEOUT_MS,
  CALLBACK_RETRY_MS,
  CALLBACK_MAX_ATTEMPTS,
  SOFT_POLL_MS,
};
