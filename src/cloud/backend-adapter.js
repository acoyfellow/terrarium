// Cloud Terrarium run-cell backend adapter port.
//
// The DO-like control cell (src/cloud/local-run-cell.js `TerrariumRunCell`)
// must not know whether a run executes as a detached host process, a Cloudflare
// Container instance, or a Sandbox isolate. It only speaks a narrow PORT:
//
//   start(spec)          -> { executionRef, pid, ...meta }   (detached; no live handle)
//   waitExit(ref)        -> Promise<{ exitCode, signal, cancelled?, timedOut? }>
//   logChunks(ref)       -> string[]   (ordered persisted append-only chunks)
//   cancel(ref)          -> void       (addressed by ref, not a held handle)
//   timeout(ref)         -> void       (deadline; addressed by ref)
//
// `DetachedProcessBackend` in local-run-cell.js is the reference adapter. This
// file adds:
//   1. `BACKEND_ADAPTER_METHODS` + `assertBackendAdapter()` — a conformance
//      contract so any new substrate can be validated as drop-in.
//   2. `SandboxContainerBackend` — a second adapter modeling a Cloudflare
//      Container / Sandbox substrate (provisioning latency, an image, a
//      sandbox id, a boot record) that still satisfies the exact same port,
//      proving the control cell is backend-agnostic with NO cell changes.
//
// Everything here is in-memory and deterministic. No real containers, no
// deploy, no network — this is a spike shape, not a runtime.

import { DetachedProcessBackend } from "./local-run-cell.js";

/** The methods every run-cell backend adapter MUST implement (the port). */
export const BACKEND_ADAPTER_METHODS = Object.freeze([
  "start",
  "waitExit",
  "logChunks",
  "cancel",
  "timeout",
]);

/**
 * Fail-closed conformance check. Throws if `backend` is missing any port
 * method. Use this at wiring time so a half-implemented substrate can never be
 * silently handed to a control cell.
 */
export function assertBackendAdapter(backend, label = "backend") {
  if (!backend || typeof backend !== "object") {
    throw new TypeError(`${label} is not a backend adapter object`);
  }
  const missing = BACKEND_ADAPTER_METHODS.filter((m) => typeof backend[m] !== "function");
  if (missing.length) {
    throw new TypeError(`${label} is missing backend adapter methods: ${missing.join(", ")}`);
  }
  return backend;
}

/**
 * SPIKE-ONLY container-shaped backend adapter.
 *
 * NOT A PRODUCTION BACKEND. Models the Cloudflare Container / Sandbox substrate
 * shape using the in-memory detached-execution reference adapter. Exists so
 * the run-cell tests can prove the port is backend-agnostic without booting
 * any real container.
 *
 * A production Worker MUST use `SandboxContainerBackendReal` from
 * `./sandbox-backend.js`. The DO's `tryCreateSandboxBackend()` path never
 * constructs this class; if you see this class in a hot path in the Worker,
 * that is a bug — fail closed.
 */
export class SandboxContainerBackend {
  #image;
  #sandboxClass;
  #inner;
  #sandboxSeq = 0;
  #meta = new Map(); // executionRef -> { sandboxId, image, sandboxClass, bootedAt }

  constructor({
    image = "terrarium/sandbox:latest",
    sandboxClass = "isolate",
    inner = new DetachedProcessBackend(),
    clock = () => 0, // injectable deterministic clock (no real time)
  } = {}) {
    assertBackendAdapter(inner, "inner backend");
    this.#image = image;
    this.#sandboxClass = sandboxClass;
    this.#inner = inner;
    this.clock = clock;
  }

  /**
   * Provision a sandbox/container, then start the detached execution inside it.
   * Returns the opaque executionRef plus container metadata for observability.
   */
  start(spec = {}) {
    const started = this.#inner.start(spec);
    const sandboxId = `sbx_${++this.#sandboxSeq}_${spec.contract?.runId ?? "unknown"}`;
    const record = {
      sandboxId,
      image: spec.image ?? this.#image,
      sandboxClass: spec.sandboxClass ?? this.#sandboxClass,
      bootedAt: this.clock(),
    };
    this.#meta.set(started.executionRef, record);
    return { ...started, ...record };
  }

  waitExit(executionRef) {
    return this.#inner.waitExit(executionRef);
  }

  logChunks(executionRef) {
    return this.#inner.logChunks(executionRef);
  }

  cancel(executionRef) {
    return this.#inner.cancel(executionRef);
  }

  timeout(executionRef) {
    return this.#inner.timeout(executionRef);
  }

  /** Non-port helper: container metadata for a ref (observability/audit only). */
  describe(executionRef) {
    return this.#meta.get(executionRef) ?? null;
  }
}

// Self-check: the container adapter conforms to its own port at module load.
assertBackendAdapter(SandboxContainerBackend.prototype, "SandboxContainerBackend");
