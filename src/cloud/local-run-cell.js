// Minimal local Cloud Terrarium proof.
//
// A single self-contained, in-memory model of the durable execution + terminal
// callback layer a Cloud Terrarium cell must provide, with NO real processes, clocks,
// files, or network. It exists to prove the invariants that matter:
//
//   1. One bounded task -> one child -> one CORRELATED receipt.
//      A verified TERRARIUM_RESULT (runId + taskFingerprint + nonce all match)
//      is the only thing accepted as task success. Exit 0 alone is not.
//   2. Missing / mismatched / malformed receipts on a clean exit are
//      "inconclusive", never "done".
//   3. Finalization is idempotent: collecting a run twice emits exactly one
//      terminal callback event.
//   4. Terminal callbacks survive finish-before-subscribe (durable journal replay).
//   5. Status is owner-scoped: a cross-owner read fails closed.
//
// Semantics mirror src/run-machine.js and src/core.js validateTaskContractOutput
// deliberately; this file just makes them exercisable without any I/O.

import { createHash, randomUUID } from "node:crypto";

const TASK_RESULT_MARKER = "TERRARIUM_RESULT=";
const MAX_TASK_RESULT_LINE_BYTES = 16 * 1024;
const TASK_RESULT_KEYS = new Set(["runId", "taskFingerprint", "nonce", "summary"]);

function cloneJson(value) {
  return value == null ? value : structuredClone(value);
}

/** Stable, short task identity — same construction as core.taskFingerprint. */
export function taskFingerprint(task) {
  return createHash("sha256").update(String(task)).digest("hex").slice(0, 24);
}

/**
 * Validate a child's captured stdout against the expected task contract.
 * Returns one of: verified | missing | malformed | mismatch.
 * Mirrors core.validateTaskContractOutput.
 */
export function validateReceipt(output, expected) {
  if (!expected) return { status: "not-required" };
  const lines = String(output ?? "")
    .split(/[\n\r\u2028\u2029]/)
    .filter((value) => value.startsWith(TASK_RESULT_MARKER));
  if (lines.length === 0) return { status: "missing" };
  if (lines.length !== 1 || Buffer.byteLength(lines[0], "utf8") > MAX_TASK_RESULT_LINE_BYTES) {
    return { status: "malformed" };
  }
  let receipt;
  try {
    receipt = JSON.parse(lines[0].slice(TASK_RESULT_MARKER.length));
  } catch {
    return { status: "malformed" };
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return { status: "malformed" };
  if (Object.keys(receipt).some((key) => !TASK_RESULT_KEYS.has(key))) return { status: "malformed" };
  if (
    receipt.runId !== expected.runId ||
    receipt.taskFingerprint !== expected.taskFingerprint ||
    receipt.nonce !== expected.nonce
  ) {
    return { status: "mismatch" };
  }
  if (typeof receipt.summary !== "string" || !receipt.summary.trim() || receipt.summary.length > 2000) {
    return { status: "malformed" };
  }
  return { status: "verified", summary: receipt.summary.trim() };
}

/** Durable run metadata (status, owner, contract, terminal receipt). */
export class RunStateStore {
  #runs = new Map();
  create(runId, record) {
    if (this.#runs.has(runId)) throw new Error(`run already exists: ${runId}`);
    this.#runs.set(runId, { runId, ...record });
    return this.#runs.get(runId);
  }
  get(runId) {
    return this.#runs.get(runId) ?? null;
  }
  patch(runId, patch) {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    Object.assign(run, patch);
    return run;
  }
  has(runId) {
    return this.#runs.has(runId);
  }
}

/** Append-only per-run log artifact store. */
export class LogArtifactStore {
  #logs = new Map();
  append(runId, chunk) {
    const list = this.#logs.get(runId) ?? [];
    list.push(String(chunk));
    this.#logs.set(runId, list);
  }
  read(runId) {
    return (this.#logs.get(runId) ?? []).join("");
  }
}

/** Owner -> runIds index for owner-scoped listing. */
export class RunIndexStore {
  #byOwner = new Map();
  add(ownerId, runId) {
    const set = this.#byOwner.get(ownerId) ?? new Set();
    set.add(runId);
    this.#byOwner.set(ownerId, set);
  }
  list(ownerId) {
    return [...(this.#byOwner.get(ownerId) ?? new Set())];
  }
}

/**
 * Durable terminal callback transport.
 * - journal is the terminal callback journal: dedup + replay source of truth
 *   (event_id unique).
 * - subscribing to a runId replays already-journaled terminal callback events
 *   (finish-before-subscribe).
 * - delivery is owner-isolated: a subscriber only sees events for its owner.
 */
export class TerminalCallbackTransport {
  #journal = new Map(); // eventId -> terminal callback event
  #byRun = new Map(); // runId -> [eventId]
  #subscribers = new Map(); // subscriberId -> { runId, ownerId, mailbox: Map }

  queue(event) {
    if (!event || !event.eventId || !event.runId) throw new Error("terminal callback event requires eventId and runId");
    if (this.#journal.has(event.eventId)) return { queued: false, deduped: true };
    this.#journal.set(event.eventId, event);
    const list = this.#byRun.get(event.runId) ?? [];
    list.push(event.eventId);
    this.#byRun.set(event.runId, list);
    for (const sub of this.#subscribers.values()) {
      if (this.#matches(sub, event)) sub.mailbox.set(event.eventId, event);
    }
    return { queued: true, deduped: false };
  }

  subscribe(subscriberId, { runId, ownerId }) {
    if (typeof ownerId !== "string" || !ownerId.trim()) throw new Error("terminal callback subscription requires ownerId");
    const sub = { runId, ownerId, mailbox: new Map() };
    this.#subscribers.set(subscriberId, sub);
    for (const eventId of this.#byRun.get(runId) ?? []) {
      const event = this.#journal.get(eventId);
      if (this.#matches(sub, event)) sub.mailbox.set(eventId, event); // replay
    }
    return sub;
  }

  /** Atomically drain a subscriber's pending mailbox. */
  collect(subscriberId) {
    const sub = this.#subscribers.get(subscriberId);
    if (!sub) throw new Error(`unknown subscriber: ${subscriberId}`);
    const events = [...sub.mailbox.values()];
    sub.mailbox.clear();
    return events;
  }

  #matches(sub, event) {
    if (!event || sub.runId !== event.runId) return false;
    if (!event.ownerId) return false;
    return sub.ownerId === event.ownerId;
  }
}

/**
 * Deterministic DETACHED backend. Models the Cloud Terrarium substrate (a real
 * OS process, a sandbox, a Durable Object alarm): the RunCell does NOT hold the
 * live child handle. start() returns only an opaque `executionRef`; the backend
 * itself is the durable substrate that outlives any single RunCell instance.
 *
 * Signals (cancel/timeout) and finalization (waitExit/logChunks) are addressed
 * by `executionRef`, so a RunCell that crashed and restarted — losing every
 * in-memory handle — can still cancel, await, and finalize a run purely from
 * the persisted ref. This is the red-team P0 fix: no held live handle.
 *
 * Logs are exposed as an ordered array of persisted chunks (logChunks), mirroring
 * an append-only log store rather than a single live stdout() buffer. A receipt
 * line may be split across chunk boundaries; the store rejoins them.
 *
 * Partial-log fidelity: a child killed by cancel()/timeout() before writing its
 * receipt yields only the bytes flushed so far with NO TERRARIUM_RESULT marker.
 * Set receiptDespiteKill:true to model a child that DID flush a full verified
 * receipt yet was still killed; cancel/timeout intent must win over that receipt.
 */
export class DetachedProcessBackend {
  #pid = 1000;
  #ref = 0;
  #executions = new Map(); // executionRef -> execution record (durable substrate)

  /** Start a detached execution. Returns an opaque ref; retains NO caller handle. */
  start(spec = {}) {
    const {
      contract,
      exitCode = 0,
      emitReceipt = true,
      receiptOverride = null,
      extraStdout = "",
      rawStdout = null,
      blocks = false,
      partialStdout = "task starting\n",
      receiptDespiteKill = false,
      chunked = false,
    } = spec;

    const executionRef = `exec_${++this.#ref}_${contract.runId}`;
    const pid = ++this.#pid;

    let settled = false;
    let outcome = "exit"; // "exit" | "cancelled" | "timedOut"
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const finish = (result, kind) => {
      if (settled) return;
      settled = true;
      outcome = kind;
      resolveExit(result);
    };
    if (!blocks) finish({ exitCode, signal: null }, "exit");

    const receiptLine = () => {
      const receipt = {
        runId: contract.runId,
        taskFingerprint: contract.taskFingerprint,
        nonce: contract.nonce,
        summary: "task-specific result",
        ...(receiptOverride ?? {}),
      };
      return `${TASK_RESULT_MARKER}${JSON.stringify(receipt)}\n`;
    };

    // Ordered persisted log chunks (as they would land in an append-only store).
    const logChunks = () => {
      if (rawStdout != null) return [String(rawStdout)];
      // Killed before completing: only partial bytes flushed, and (unless
      // explicitly modeling a raced receipt) no result marker was ever written.
      if (outcome !== "exit") {
        return receiptDespiteKill ? [partialStdout, receiptLine()] : [partialStdout];
      }
      const chunks = [partialStdout];
      if (emitReceipt) {
        const line = receiptLine();
        if (chunked) {
          // Split the receipt line across a chunk boundary so it is only
          // reconstructable from the joined persisted store, never one chunk.
          const mid = Math.max(1, Math.floor(line.length / 2));
          chunks.push(line.slice(0, mid), line.slice(mid));
        } else {
          chunks.push(line);
        }
      }
      if (extraStdout) chunks.push(extraStdout);
      return chunks;
    };

    this.#executions.set(executionRef, {
      pid,
      waitExit: () => exitPromise,
      logChunks,
      cancel: () => finish({ exitCode: 143, signal: "SIGTERM", cancelled: true }, "cancelled"),
      timeout: () => finish({ exitCode: 124, signal: "SIGKILL", timedOut: true }, "timedOut"),
    });

    return { executionRef, pid };
  }

  #exec(executionRef) {
    const exec = this.#executions.get(executionRef);
    if (!exec) throw new Error(`unknown executionRef: ${executionRef}`);
    return exec;
  }

  /** Await terminal exit by ref (survives RunCell handle loss). */
  waitExit(executionRef) {
    return this.#exec(executionRef).waitExit();
  }

  /** Ordered persisted log chunks by ref. */
  logChunks(executionRef) {
    return this.#exec(executionRef).logChunks();
  }

  /** Signal cancel by ref. */
  cancel(executionRef) {
    this.#exec(executionRef).cancel();
  }

  /** Signal deadline/timeout by ref. */
  timeout(executionRef) {
    this.#exec(executionRef).timeout();
  }

  /** Round 5B.1: describe() returns a deterministic synthetic address so the
   *  DO admission path can persist sandboxId/processId synchronously in test
   *  scenarios that reuse this backend. Production uses SandboxContainerBackendReal. */
  describe(executionRef) {
    const exec = this.#executions.get(executionRef);
    if (!exec) return null;
    return {
      sandboxId: `local-sbx-${exec.pid}`,
      processId: `local-proc-${exec.pid}`,
    };
  }
}

/**
 * The cell: owns exactly one child per run and produces one correlated receipt.
 */
export class TerrariumRunCell {
  #state;
  #logs;
  #index;
  #callbacks;
  #backend;
  // In-memory dedup ONLY for concurrent collect() calls within one live cell.
  // It is NOT the source of truth: durable state (executionRef + intent +
  // finalized) is, so a restarted cell with an empty map still finalizes.
  #collectPromises = new Map(); // runId -> Promise<terminal>

  constructor({
    state = new RunStateStore(),
    logs = new LogArtifactStore(),
    index = new RunIndexStore(),
    callbacks,
    backend = new DetachedProcessBackend(),
    // Deprecated/internal back-compat: accept the old `wake` option key.
    wake,
  } = {}) {
    this.#state = state;
    this.#logs = logs;
    this.#index = index;
    this.#callbacks = callbacks ?? wake ?? new TerminalCallbackTransport();
    this.#backend = backend;
  }

  get callbacks() {
    return this.#callbacks;
  }

  /** @deprecated internal back-compat alias for {@link callbacks}. */
  get wake() {
    return this.#callbacks;
  }

  #requireRun(runId) {
    const run = this.#state.get(runId);
    if (!run) {
      const err = new Error(`unknown run: ${runId}`);
      err.code = "ENOENT";
      throw err;
    }
    return run;
  }

  /** Launch one bounded task; mints the correlated contract; persists executionRef. */
  launch({ task, ownerId, runId = `ter_${randomUUID().replace(/-/g, "").slice(0, 20)}`, spec = {} }) {
    if (!task || !ownerId) throw new Error("launch requires task and ownerId");
    const contract = {
      runId,
      taskFingerprint: taskFingerprint(task),
      // Nonce is ALWAYS server-minted. A client-supplied spec.nonce is ignored
      // so the advertised correlation triple (runId + taskFingerprint + nonce)
      // is fully server-controlled and unforgeable by a caller or a task.
      nonce: randomUUID(),
    };
    // Detached start: we keep the ref, not the live handle.
    const { executionRef, pid } = this.#backend.start({ ...spec, contract });
    this.#state.create(runId, {
      ownerId,
      task,
      status: "running",
      contract,
      executionRef, // durable pointer to the detached execution
      pid,
      intent: null, // durable cancel/deadline intent (survives handle loss)
      terminal: null,
      finalized: false,
      capabilityEnvelope: cloneJson(spec.capabilityEnvelope ?? null),
    });
    this.#index.add(ownerId, runId);
    return { runId, contract, executionRef };
  }

  /** Persist cancel intent durably, then signal the detached execution by ref.
   *  Round 5B.1: returns the backend's cancel result so the caller can anchor
   *  the kill promise with waitUntil and poll the substrate before collect. */
  cancel(runId) {
    const run = this.#requireRun(runId);
    this.#state.patch(runId, { intent: "cancel" });
    return this.#backend.cancel(run.executionRef);
  }

  /** Persist deadline intent durably, then signal the detached execution by ref.
   *  Round 5B.1: returns the backend's timeout result. */
  timeout(runId) {
    const run = this.#requireRun(runId);
    this.#state.patch(runId, { intent: "timeout" });
    return this.#backend.timeout(run.executionRef);
  }

  /**
   * Idempotent finalization via persisted executionRef (NO live handle needed).
   * Awaits exit by ref, persists log chunks, classifies from the persisted log
   * store + durable intent, commits terminal state, emits exactly ONE terminal
   * callback.
   */
  collect(runId) {
    const run = this.#requireRun(runId);
    // Already terminal (possibly committed by a prior, now-crashed cell):
    // return the durable terminal and ensure its callback exists (self-heal).
    if (run.finalized && run.terminal) {
      this.#emitTerminalCallback(runId, run.terminal, run.ownerId);
      return Promise.resolve(run.terminal);
    }
    const inflight = this.#collectPromises.get(runId);
    if (inflight) return inflight; // dedup concurrent collects within this cell
    const p = this.#finalize(runId, run.executionRef);
    this.#collectPromises.set(runId, p);
    return p;
  }

  async #finalize(runId, executionRef) {
    const run = this.#state.get(runId);
    const exit = await this.#backend.waitExit(executionRef);
    // Persist each log chunk to the durable append-only store.
    for (const chunk of this.#backend.logChunks(executionRef)) {
      this.#logs.append(runId, chunk);
    }
    // Round 5B.1: await any pending R2 flushes before classifying. If log
    // persistence FAILED (R2 unavailable), the run must terminate as
    // infrastructure-failed with reason=log-persistence-failed; NEVER emit
    // done/verified on top of a broken log store. Emit exactly one callback.
    let logPersistFailed = null;
    if (typeof this.#logs.flush === "function") {
      try { await this.#logs.flush(runId); }
      catch (err) { logPersistFailed = err?.message || String(err); }
    }
    // Re-read durable intent so a cancel/deadline that arrived after start
    // (even to a different cell instance) still wins.
    const intent = this.#state.get(runId).intent;

    let terminal;
    if (logPersistFailed) {
      terminal = {
        status: "failed",
        ok: false,
        exitCode: exit.exitCode,
        signal: exit.signal ?? null,
        taskContractStatus: "not-applicable",
        reason: "log-persistence-failed",
        infraError: logPersistFailed,
      };
      this.#state.patch(runId, { status: terminal.status, terminal, finalized: true });
      this.#emitTerminalCallback(runId, terminal, run.ownerId);
      return terminal;
    }
    if (exit.cancelled || intent === "cancel") {
      terminal = { status: "cancelled", ok: false, exitCode: exit.exitCode, signal: exit.signal ?? null, taskContractStatus: "not-applicable", reason: "cancel-requested" };
    } else if (exit.timedOut || intent === "timeout") {
      terminal = { status: "failed", ok: false, exitCode: exit.exitCode, signal: exit.signal ?? null, taskContractStatus: "not-applicable", reason: "deadline-reached" };
    } else {
      // Validate the receipt from the PERSISTED log store (rejoined chunks),
      // never from live stdout. Use the overflow-aware read so a receipt that
      // landed in an R2 overflow chunk (very large output) is still found;
      // falls back to inline logs when no store supports overflow reads.
      const persistedLog = typeof this.#logs.readWithOverflow === "function"
        ? await this.#logs.readWithOverflow(runId)
        : this.#logs.read(runId);
      const receipt = validateReceipt(persistedLog, run.contract);
      if (receipt.status === "verified") {
        terminal = {
          status: exit.exitCode === 0 ? "done" : "failed",
          ok: exit.exitCode === 0,
          exitCode: exit.exitCode,
          signal: exit.signal ?? null,
          taskContractStatus: "verified",
          taskResultSummary: receipt.summary,
          reason: "verified-receipt",
        };
      } else {
        terminal = {
          status: exit.exitCode === 0 ? "inconclusive" : "failed",
          ok: false,
          exitCode: exit.exitCode,
          signal: exit.signal ?? null,
          taskContractStatus: receipt.status,
          note: `Task contract ${receipt.status}; process exit is not accepted as task success.`,
          reason: `receipt-${receipt.status}`,
        };
      }
    }

    // Commit terminal state FIRST. A crash here (before the callback emit) is
    // repaired by reconcile(); the stable eventId keeps it single-delivery.
    this.#state.patch(runId, { status: terminal.status, terminal, finalized: true });
    this.#emitTerminalCallback(runId, terminal, run.ownerId);
    return terminal;
  }

  /** Emit the single terminal callback; stable eventId => journal dedups repeats. */
  #emitTerminalCallback(runId, terminal, ownerId) {
    return this.#callbacks.queue({
      eventId: `evt_${runId}_terminal`,
      runId,
      ownerId,
      type: "run.finished",
      status: terminal.status,
      ok: terminal.ok,
    });
  }

  /**
   * Crash recovery: if a run is durably terminal but its terminal callback was
   * never emitted (crash after the terminal commit, before the callback), re-emit
   * it. Idempotent — the stable eventId means a run that already emitted its
   * callback stays single-delivery.
   */
  reconcile(runId) {
    const run = this.#requireRun(runId);
    if (!run.finalized || !run.terminal) {
      return { repaired: false, reason: "not-finalized" };
    }
    const res = this.#emitTerminalCallback(runId, run.terminal, run.ownerId);
    return { repaired: Boolean(res.queued), deduped: Boolean(res.deduped) };
  }

  /** Owner-scoped status read. Fails closed on cross-owner access. */
  status(runId, requesterOwnerId) {
    const run = this.#state.get(runId);
    if (!run) {
      const err = new Error(`unknown run: ${runId}`);
      err.code = "ENOENT";
      throw err;
    }
    if (run.ownerId !== requesterOwnerId) {
      const err = new Error("run access denied");
      err.code = "EACCES";
      throw err;
    }
    return {
      runId: run.runId,
      ownerId: run.ownerId,
      status: run.status,
      terminal: run.terminal,
      taskFingerprint: run.contract.taskFingerprint,
      capabilityEnvelope: cloneJson(run.capabilityEnvelope ?? null),
    };
  }

  list(ownerId) {
    return this.#index.list(ownerId);
  }

  logs(runId) {
    return this.#logs.read(runId);
  }

  subscribe(subscriberId, opts) {
    return this.#callbacks.subscribe(subscriberId, opts);
  }

  collectCallbacks(subscriberId) {
    return this.#callbacks.collect(subscriberId);
  }

  /** @deprecated internal back-compat alias for {@link collectCallbacks}. */
  collectWakes(subscriberId) {
    return this.collectCallbacks(subscriberId);
  }
}

/** @deprecated internal back-compat alias for {@link TerminalCallbackTransport}. */
export const WakeTransport = TerminalCallbackTransport;
