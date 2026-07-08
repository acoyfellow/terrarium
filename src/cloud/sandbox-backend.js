// Cloud Terrarium production execution backend — @cloudflare/sandbox 0.12.
//
// Real Cloudflare-native substrate for a run. Conforms to the run-cell backend
// port declared in `./backend-adapter.js` (BACKEND_ADAPTER_METHODS): start,
// waitExit, logChunks, cancel, timeout. The RunControlDO holds no live child
// handle — every operation is addressed by the opaque `executionRef` this
// adapter mints so a DO that lost its live JS state can still cancel, timeout,
// and finalize a run purely from durable data.
//
// A run is executed inside a Cloudflare Sandbox Durable Object obtained via
// `getSandbox(env.TERRARIUM_SANDBOX, sandboxId)`. Actual @cloudflare/sandbox
// API signatures (verified against the installed 0.12.x d.ts):
//
//   sandbox.exec(command: string, options?: ExecOptions): Promise<ExecResult>
//   sandbox.startProcess(command: string, options?: ProcessOptions): Promise<Process>
//   sandbox.getProcess(id, sessionId?): Promise<Process | null>
//   sandbox.killProcess(id, signal?): Promise<void>
//   sandbox.getProcessLogs(id): Promise<{ stdout, stderr, processId }>
//   sandbox.writeFile(path, content, options?): Promise<WriteFileResult>
//   sandbox.destroy(): Promise<void>  // container instance destroy (inherited from Container)
//
// A distinct sandbox id per run gives us owner+run isolation at the substrate
// level: two runs cannot share a container, and cancel/timeout on one run
// cannot signal the wrong sandbox.
//
// SAFETY: task text is NEVER passed to a shell as a command. The runner writes
// the task body to `/workspace/task.txt` inside the sandbox and then invokes a
// bounded, non-shell runner entrypoint that reads the task file. The command
// line is a fixed argv with no interpolation of task content.
//
// The `@cloudflare/sandbox` binding is loaded lazily so this module is safe to
// import in Node tests without the Workers runtime. When the binding is not
// available (test / dev-with-fixture mode), pass a mock `getSandbox` via the
// constructor.

import { assertBackendAdapter, BACKEND_ADAPTER_METHODS } from "./backend-adapter.js";

/** Fixed runner entrypoint invoked inside the sandbox. Reads /workspace/task.txt
 *  and prints TASK_RECEIVED / TASK_ENDED markers around whatever the bounded
 *  agent produces. This is a *bounded runner* — the task file is data, never
 *  interpreted as a shell program. A production deployment can replace
 *  DEFAULT_RUNNER_COMMAND with a purpose-built agent binary at build time. */
const DEFAULT_RUNNER_COMMAND = "/bin/sh /usr/local/bin/terrarium-runner";
const TASK_INBOX_PATH = "/workspace/terrarium-task.txt";
const CONTRACT_INBOX_PATH = "/workspace/terrarium-contract.json";

/** Bounded per-run log buffer. Keep both the beginning and end so a receipt
 *  emitted as the runner's final line survives large normal output. Counts are
 *  UTF-8 bytes, never JavaScript code units. */
const MAX_LOG_BYTES = 128 * 1024;
const LOG_HEAD_BYTES = MAX_LOG_BYTES / 2;
const LOG_TAIL_BYTES = MAX_LOG_BYTES - LOG_HEAD_BYTES;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
function isContainerStartingError(error) {
  const message = error?.message || String(error || "");
  return /container is starting|please retry in a moment/i.test(message);
}

function concatBytes(left, right) {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

class Utf8HeadTailBuffer {
  constructor() {
    this.head = new Uint8Array(0);
    this.tail = new Uint8Array(0);
    this.byteCount = 0;
  }

  append(text) {
    if (text == null) return;
    let incoming = UTF8_ENCODER.encode(String(text));
    if (incoming.byteLength === 0) return;
    this.byteCount += incoming.byteLength;

    if (this.head.byteLength < LOG_HEAD_BYTES) {
      const take = Math.min(LOG_HEAD_BYTES - this.head.byteLength, incoming.byteLength);
      this.head = concatBytes(this.head, incoming.slice(0, take));
      incoming = incoming.slice(take);
    }
    if (incoming.byteLength > 0) {
      const combined = concatBytes(this.tail, incoming);
      this.tail = combined.byteLength > LOG_TAIL_BYTES
        ? combined.slice(combined.byteLength - LOG_TAIL_BYTES)
        : combined;
    }
  }

  replace(stdout = "", stderr = "") {
    this.head = new Uint8Array(0);
    this.tail = new Uint8Array(0);
    this.byteCount = 0;
    this.append(stdout);
    this.append(stderr);
  }

  get retainedBytes() {
    return this.head.byteLength + this.tail.byteLength;
  }

  get truncatedBytes() {
    return Math.max(0, this.byteCount - this.retainedBytes);
  }

  chunks() {
    if (this.byteCount === 0) return [];
    const head = UTF8_DECODER.decode(this.head);
    const tail = UTF8_DECODER.decode(this.tail);
    if (this.truncatedBytes === 0) return [head + tail];
    return [
      head,
      `\n[terrarium:log-truncated bytes=${this.truncatedBytes} totalBytes=${this.byteCount}]\n`,
      tail,
    ];
  }
}

function deterministicProcessId(runId) {
  const value = String(runId || "");
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(value)) {
    throw new Error("contract.runId is not safe for a deterministic processId");
  }
  return `terrarium-${value}`;
}

/** Per-execution runtime state held in memory. Not the source of truth: the
 *  durable RunStateStore inside the DO is; this map is a warm cache for a
 *  single alarm/request lifetime, and is safe to lose. */
class ExecutionRecord {
  constructor({ sandboxId, contract, deadlineMs, processId, task = null }) {
    this.sandboxId = sandboxId;
    this.contract = contract;
    this.task = task;
    this.deadlineMs = deadlineMs;
    this.processId = processId;
    this.logs = new Utf8HeadTailBuffer();
    this.exit = null; // { exitCode, signal, cancelled?, timedOut? }
    this.exitResolvers = [];
    this.cancelled = false;
    this.timedOut = false;
    this.launching = true;
    this.startRequested = false;
    this.launchAttempt = null;
    this.bootedAt = Date.now();
  }

  appendChunk(text) {
    this.logs.append(text);
  }

  replaceLogs(stdout, stderr) {
    this.logs.replace(stdout, stderr);
  }

  logChunks() {
    return this.logs.chunks();
  }

  waitExit() {
    if (this.exit) return Promise.resolve(this.exit);
    return new Promise((resolve) => this.exitResolvers.push(resolve));
  }

  settle(result) {
    if (this.exit) return; // one-shot
    this.exit = result;
    const rs = this.exitResolvers.splice(0);
    for (const r of rs) r(result);
  }
}

/**
 * Production backend for the RunControlDO.
 *
 * Uses @cloudflare/sandbox 0.12 API. The command executed inside the sandbox
 * is a FIXED runner entrypoint; task text is delivered as a file, not as a
 * shell argument. Startup + streaming uses `startProcess` so cancel/timeout
 * can address the child by processId (via `killProcess`) purely from durable
 * state, and logs can be re-read after handle loss via `getProcessLogs`.
 */
export class SandboxContainerBackendReal {
  #getSandbox;
  #sandboxBinding;
  #runnerCommand;
  #executions = new Map(); // executionRef -> ExecutionRecord
  #refSeq = 0;

  constructor({
    getSandbox,          // function(binding, id) -> sandbox stub
    sandboxBinding,      // env.TERRARIUM_SANDBOX (Durable Object namespace)
    runnerCommand = DEFAULT_RUNNER_COMMAND,
  } = {}) {
    if (typeof getSandbox !== "function") {
      throw new TypeError("SandboxContainerBackendReal requires getSandbox()");
    }
    if (!sandboxBinding) {
      throw new TypeError("SandboxContainerBackendReal requires sandboxBinding");
    }
    this.#getSandbox = getSandbox;
    this.#sandboxBinding = sandboxBinding;
    this.#runnerCommand = runnerCommand;
  }

  /** Provision one sandbox and start the delegated task inside it. The process
   *  address is deterministic and available synchronously for durable commit. */
  start(spec = {}) {
    const contract = spec.contract;
    if (!contract || !contract.runId) throw new Error("start(spec.contract.runId) required");
    const sandboxId = `run-${contract.runId}`;
    const processId = deterministicProcessId(contract.runId);
    const executionRef = `sbx_${++this.#refSeq}_${contract.runId}`;
    const record = new ExecutionRecord({
      sandboxId,
      processId,
      contract,
      deadlineMs: spec.deadlineMs ?? null,
      task: String(spec.task ?? ""),
    });
    this.#executions.set(executionRef, record);

    // Fire-and-forget: launch the sandbox execution. Errors are captured into
    // the bounded log and translated into a non-zero terminal.
    this.#launch(executionRef, record, spec.task).catch((err) => {
      record.appendChunk(`\n[terrarium:sandbox-launch-error] ${err?.message || String(err)}\n`);
      record.settle({ exitCode: 1, signal: null });
    });

    return { executionRef, sandboxId, processId };
  }

  describe(executionRef) {
    const record = this.#require(executionRef);
    return {
      sandboxId: record.sandboxId,
      processId: record.processId,
      byteCount: record.logs.byteCount,
      retainedBytes: record.logs.retainedBytes,
      truncatedBytes: record.logs.truncatedBytes,
    };
  }

  async #launch(executionRef, record, task) {
    if (record.launchAttempt) return record.launchAttempt;
    const attempt = this.#launchAttempt(executionRef, record, task);
    record.launchAttempt = attempt.finally(() => { record.launchAttempt = null; });
    return record.launchAttempt;
  }

  async #launchAttempt(executionRef, record, task) {
    let sandbox;
    try {
      sandbox = await this.#getSandbox(this.#sandboxBinding, record.sandboxId);
    } catch (err) {
      if (isContainerStartingError(err)) return;
      record.appendChunk(`[terrarium:sandbox-get-error] ${err?.message || String(err)}\n`);
      record.settle({ exitCode: 1, signal: null });
      return;
    }

    if (record.cancelled || record.timedOut || record.exit) return;

    // 1. Deliver task text as data via writeFile — NEVER as a shell argument.
    //    Task text is opaque bytes to the runner; no interpolation occurs.
    try {
      if (typeof sandbox.writeFile !== "function") {
        throw new Error("sandbox.writeFile is required");
      }
      await sandbox.writeFile(TASK_INBOX_PATH, String(task ?? ""));
      if (record.cancelled || record.timedOut || record.exit) return;
      await sandbox.writeFile(
        CONTRACT_INBOX_PATH,
        JSON.stringify({
          runId: record.contract.runId,
          taskFingerprint: record.contract.taskFingerprint,
          nonce: record.contract.nonce,
        }),
      );
    } catch (err) {
      if (isContainerStartingError(err)) return;
      record.appendChunk(`[terrarium:sandbox-write-task-error] ${err?.message || String(err)}\n`);
      record.settle({ exitCode: 1, signal: null });
      return;
    }
    if (record.cancelled || record.timedOut || record.exit) return;

    // 2. Start the bounded runner as a background process so we hold a
    //    processId for cancel/killProcess by ref (no live handle needed).
    //    The runner reads TASK_INBOX_PATH and produces stdout including the
    //    single-line TERRARIUM_RESULT= receipt.
    let proc = null;
    try {
      if (typeof sandbox.startProcess !== "function") {
        throw new Error("sandbox.startProcess is required for durable execution");
      }
      record.startRequested = true;
      proc = await sandbox.startProcess(this.#runnerCommand, {
        processId: record.processId,
        autoCleanup: false,
        timeout: record.deadlineMs || undefined,
      });
      record.startRequested = false;
      record.launching = false;
      if (!proc || proc.id !== record.processId) {
        throw new Error(`sandbox returned unexpected processId: ${proc?.id || "missing"}`);
      }
      // Cancel/timeout may race the await above. Intent wins and the newly
      // created deterministic process is killed immediately.
      if (record.cancelled || record.timedOut || record.exit) {
        const killed = await this.#killChild(record, record.timedOut ? "SIGKILL" : "SIGTERM");
        if (killed && !record.exit) {
          record.settle(record.timedOut
            ? { exitCode: 124, signal: "SIGKILL", timedOut: true }
            : { exitCode: 143, signal: "SIGTERM", cancelled: true });
        }
        return;
      }
    } catch (err) {
      record.startRequested = false;
      if (isContainerStartingError(err)) {
        record.launching = true;
        return;
      }
      record.launching = false;
      record.appendChunk(`[terrarium:sandbox-start-error] ${err?.message || String(err)}\n`);
      if (!record.exit) record.settle({ exitCode: 1, signal: null });
      return;
    }

    // 3. Monitor asynchronously. The durable alarm path polls by processId,
    // so eviction of this in-memory waiter cannot lose terminal recovery.
    void this.#monitorProcess(record, proc);
  }

  async #monitorProcess(record, proc) {
    try {
      if (typeof proc.waitForExit !== "function") {
        throw new Error("sandbox process has no waitForExit()");
      }
      const result = await proc.waitForExit(record.deadlineMs || undefined);
      if (typeof proc.getLogs === "function") {
        const logs = await proc.getLogs();
        record.replaceLogs(logs?.stdout || "", logs?.stderr || "");
      }
      if (!record.exit) {
        const exitCode = typeof result?.exitCode === "number" ? result.exitCode : 1;
        record.settle({ exitCode, signal: null });
      }
    } catch (err) {
      try {
        if (typeof proc.getLogs === "function") {
          const logs = await proc.getLogs();
          record.replaceLogs(logs?.stdout || "", logs?.stderr || "");
        }
      } catch { /* preserve the primary wait failure */ }
      record.appendChunk(`[terrarium:sandbox-wait-error] ${err?.message || String(err)}\n`);
      if (!record.exit) record.settle({ exitCode: 1, signal: null });
    }
  }

  #require(ref) {
    const r = this.#executions.get(ref);
    if (!r) throw new Error(`unknown executionRef: ${ref}`);
    return r;
  }

  waitExit(executionRef) {
    return this.#require(executionRef).waitExit();
  }

  logChunks(executionRef) {
    return this.#require(executionRef).logChunks();
  }

  /** Cancel by ref: signals the sandbox to terminate and records durable intent.
   *  Round 5B.1: RETURNS a kill promise. Only settle waitExit AFTER killProcess
   *  confirms. If kill returns false/throws, waitExit stays unsettled so a
   *  subsequent alarm retry can attempt kill again against the deterministic
   *  process address. Before/during launch (rec.launching) the intent alone
   *  prevents launch or kills a raced launch. */
  cancel(executionRef) {
    const rec = this.#require(executionRef);
    if (rec.exit) return Promise.resolve(true); // already terminal
    rec.cancelled = true;
    // Before startProcess is requested there cannot be a child, so settling is
    // safe and #launch will stop at its next intent check. If startProcess is
    // already in flight, do not settle until its raced child is actually killed.
    if (rec.launching && !rec.startRequested) {
      rec.settle({ exitCode: 143, signal: "SIGTERM", cancelled: true });
      return Promise.resolve(true);
    }
    return this.#killChild(rec, "SIGTERM").then((ok) => {
      if (ok) rec.settle({ exitCode: 143, signal: "SIGTERM", cancelled: true });
      // Leave unsettled on failure so alarm retry can drive kill again.
      return ok;
    });
  }

  /** Timeout by ref: same as cancel but with deadline classification. */
  timeout(executionRef) {
    const rec = this.#require(executionRef);
    if (rec.exit) return Promise.resolve(true);
    rec.timedOut = true;
    if (rec.launching && !rec.startRequested) {
      rec.settle({ exitCode: 124, signal: "SIGKILL", timedOut: true });
      return Promise.resolve(true);
    }
    return this.#killChild(rec, "SIGKILL").then((ok) => {
      if (ok) rec.settle({ exitCode: 124, signal: "SIGKILL", timedOut: true });
      return ok;
    });
  }

  async #killChild(record, signal) {
    try {
      const sandbox = await this.#getSandbox(this.#sandboxBinding, record.sandboxId);
      if (!record.processId || typeof sandbox.killProcess !== "function") return false;
      await sandbox.killProcess(record.processId, signal);
      return true;
    } catch {
      // Durable intent remains authoritative; a later alarm can retry the same
      // deterministic process address. Never destroy an entire sandbox as a
      // substitute for an unknown process.
      return false;
    }
  }

  /** Non-port helper: refresh log tail via getProcessLogs (survives handle loss). */
  async refreshLogsFromSandbox(executionRef) {
    const rec = this.#require(executionRef);
    if (!rec.processId) return;
    try {
      const sandbox = await this.#getSandbox(this.#sandboxBinding, rec.sandboxId);
      if (typeof sandbox.getProcessLogs !== "function") return;
      const logs = await sandbox.getProcessLogs(rec.processId);
      rec.replaceLogs(logs?.stdout || "", logs?.stderr || "");
    } catch { /* best-effort */ }
  }

  /** Nonblocking process-state check used by alarms. */
  async poll(executionRef) {
    const rec = this.#require(executionRef);
    if (rec.exit) return { terminal: true, ...rec.exit };
    const sandbox = await this.#getSandbox(this.#sandboxBinding, rec.sandboxId);
    if (typeof sandbox.getProcess !== "function") throw new Error("sandbox.getProcess is required");
    let proc;
    try {
      proc = await sandbox.getProcess(rec.processId);
    } catch (error) {
      if (!isContainerStartingError(error) || rec.task === null) throw error;
      await this.#launch(executionRef, rec, rec.task);
      if (rec.launching && !rec.exit) await this.#launch(executionRef, rec, rec.task);
      return rec.exit ? { terminal: true, ...rec.exit } : { terminal: false, status: "launching" };
    }
    if (!proc) {
      if (rec.task !== null && rec.launching) {
        await this.#launch(executionRef, rec, rec.task);
        if (rec.launching && !rec.exit) await this.#launch(executionRef, rec, rec.task);
        return rec.exit ? { terminal: true, ...rec.exit } : { terminal: false, status: "launching" };
      }
      rec.settle({ exitCode: 1, signal: null });
      return { terminal: true, exitCode: 1, signal: null };
    }
    if (typeof proc.getLogs === "function") {
      const logs = await proc.getLogs();
      rec.replaceLogs(logs?.stdout || "", logs?.stderr || "");
    }
    const status = typeof proc.getStatus === "function" ? await proc.getStatus() : proc.status;
    if (status === "starting" || status === "running") return { terminal: false, status };
    const exitCode = proc.exitCode ?? (status === "completed" ? 0 : 1);
    rec.settle({ exitCode, signal: null });
    return { terminal: true, exitCode, signal: null, status };
  }

  /** Non-port helper: reconstruct a record from durable state after DO restart.
   *  The DO calls this when it recovers a runId → sandboxId + processId pair. */
  reattach({ executionRef, sandboxId, processId, contract, deadlineMs, task = null }) {
    if (this.#executions.has(executionRef)) return this.#executions.get(executionRef);
    if (!processId) throw new Error("reattach requires durable processId");
    const record = new ExecutionRecord({ sandboxId, contract, deadlineMs, processId, task });
    record.launching = false;
    this.#executions.set(executionRef, record);

    // Reconnect the wait promise to the durable process address. No original
    // in-memory Process object is required.
    (async () => {
      try {
        const sandbox = await this.#getSandbox(this.#sandboxBinding, sandboxId);
        if (typeof sandbox.getProcess !== "function") throw new Error("sandbox.getProcess is required");
        const proc = await sandbox.getProcess(processId);
        if (!proc) {
          if (record.task !== null) {
            record.launching = true;
            await this.#launch(executionRef, record, record.task);
            return;
          }
          record.settle({ exitCode: 1, signal: null });
          return;
        }
        if (typeof proc.getLogs === "function") {
          const logs = await proc.getLogs();
          record.replaceLogs(logs?.stdout || "", logs?.stderr || "");
        }
        let status = typeof proc.getStatus === "function" ? await proc.getStatus() : proc.status;
        if (status === "starting" || status === "running") {
          if (typeof proc.waitForExit !== "function") throw new Error("reattached process has no waitForExit()");
          const result = await proc.waitForExit(deadlineMs || undefined);
          if (typeof proc.getLogs === "function") {
            const logs = await proc.getLogs();
            record.replaceLogs(logs?.stdout || "", logs?.stderr || "");
          }
          record.settle({ exitCode: result?.exitCode ?? 1, signal: null });
          return;
        }
        status = status || "error";
        if (["completed", "failed", "killed", "error"].includes(status)) {
          record.settle({ exitCode: proc.exitCode ?? (status === "completed" ? 0 : 1), signal: null });
        }
      } catch (err) {
        if (isContainerStartingError(err) && record.task !== null) {
          record.launching = true;
          await this.#launch(executionRef, record, record.task);
          return;
        }
        record.appendChunk(`[terrarium:reattach-error] ${err?.message || String(err)}\n`);
        if (!record.exit) record.settle({ exitCode: 1, signal: null });
      }
    })();
    return record;
  }
}

// Self-check at load time: the class conforms to the run-cell backend port.
assertBackendAdapter(SandboxContainerBackendReal.prototype, "SandboxContainerBackendReal");

/**
 * Convenience: try to construct a real sandbox backend from a Worker env.
 * Returns null if the sandbox binding or module are unavailable — the caller
 * is expected to fail-closed in production.
 *
 * A production build that omitted the `@cloudflare/sandbox` peer will simply
 * see `null` here and refuse to admit runs (RunControlDO throws when no real
 * backend is available and no test backend is injected).
 */
export async function tryCreateSandboxBackend(env) {
  const sandboxBinding = env?.TERRARIUM_SANDBOX;
  if (!sandboxBinding) return null;
  let getSandbox;
  try {
    // Lazy dynamic import so this module loads in Node tests too.
    ({ getSandbox } = await import("@cloudflare/sandbox"));
  } catch {
    return null;
  }
  return new SandboxContainerBackendReal({ getSandbox, sandboxBinding });
}

export { BACKEND_ADAPTER_METHODS, TASK_INBOX_PATH, CONTRACT_INBOX_PATH, DEFAULT_RUNNER_COMMAND };
