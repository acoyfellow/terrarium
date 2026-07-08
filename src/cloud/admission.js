// Cloud Terrarium admission gate — the `POST /admit` front door.
//
// Flow proven here (all in-memory, no network, no deploy):
//
//   POST /admit  ->  AdmissionController.admit()  ->  policy gate
//                ->  TerrariumRunCell.launch()    ->  one detached execution
//                ->  admission receipt { runId, contract, executionRef }
//
// The gate is the ONLY way a run enters a cell. It fails closed: a request that
// violates policy is rejected with a stable reason and NO execution is started.
// A rejected admission can never become a running child, so budget/quota and
// ownership invariants are enforced before any substrate work.
//
// `handleAdmit()` returns an HTTP-shaped { status, body } so the same logic can
// sit behind a Worker fetch handler (Durable Object stub `POST /admit`) without
// this module importing any Cloudflare runtime.

/** Default admission policy. Conservative, additive, override per-controller. */
export const DEFAULT_ADMISSION_POLICY = Object.freeze({
  maxTaskBytes: 64 * 1024, // reject oversized task prompts at the door
  maxConcurrentPerOwner: 8, // simple per-owner concurrency budget
  allowOwners: null, // null => any non-empty ownerId; or a Set/array allowlist
});

/**
 * Validate an admission request against policy WITHOUT touching the cell.
 * Returns { ok: true } or { ok: false, status, reason } (4xx-shaped).
 */
export function normalizeCapabilityEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return undefined;
  return structuredClone(raw);
}

export function evaluateAdmission({ task, ownerId }, policy, liveCountForOwner = 0) {
  if (typeof ownerId !== "string" || !ownerId.trim()) {
    return { ok: false, status: 401, reason: "missing-owner" };
  }
  if (typeof task !== "string" || !task.trim()) {
    return { ok: false, status: 400, reason: "missing-task" };
  }
  if (Buffer.byteLength(task, "utf8") > policy.maxTaskBytes) {
    return { ok: false, status: 413, reason: "task-too-large" };
  }
  if (policy.allowOwners) {
    const allow = policy.allowOwners instanceof Set ? policy.allowOwners : new Set(policy.allowOwners);
    if (!allow.has(ownerId)) return { ok: false, status: 403, reason: "owner-not-allowed" };
  }
  if (liveCountForOwner >= policy.maxConcurrentPerOwner) {
    return { ok: false, status: 429, reason: "owner-concurrency-exceeded" };
  }
  return { ok: true };
}

/**
 * Admission controller: the durable-object-shaped control point that gates
 * admission into a single run cell. Owns nothing about execution beyond the
 * policy decision and the launch call.
 */
export class AdmissionController {
  #cell;
  #policy;

  constructor({ cell, policy = {} } = {}) {
    if (!cell || typeof cell.launch !== "function") {
      throw new TypeError("AdmissionController requires a run cell with launch()");
    }
    this.#cell = cell;
    this.#policy = { ...DEFAULT_ADMISSION_POLICY, ...policy };
  }

  get policy() {
    return this.#policy;
  }

  /** Count of not-yet-terminal runs for an owner (concurrency budget input). */
  #liveCount(ownerId) {
    let live = 0;
    for (const runId of this.#cell.list(ownerId)) {
      let st;
      try {
        st = this.#cell.status(runId, ownerId);
      } catch {
        continue;
      }
      if (st.status === "running") live += 1;
    }
    return live;
  }

  /**
   * Admit one bounded task. On accept: launches exactly one detached execution
   * and returns the correlated contract. On reject: NO execution is started.
   */
  admit({ task, ownerId, spec = {}, runId, capabilityEnvelope } = {}) {
    const verdict = evaluateAdmission({ task, ownerId }, this.#policy, this.#liveCount(ownerId));
    if (!verdict.ok) {
      return { admitted: false, status: verdict.status, reason: verdict.reason };
    }
    const normalizedEnvelope = normalizeCapabilityEnvelope(capabilityEnvelope ?? spec.capabilityEnvelope);
    const launchSpec = normalizedEnvelope ? { ...spec, capabilityEnvelope: normalizedEnvelope } : { ...spec };
    const launched = this.#cell.launch({ task, ownerId, spec: launchSpec, ...(runId ? { runId } : {}) });
    return {
      admitted: true,
      status: 202, // Accepted: run is admitted and executing detached
      runId: launched.runId,
      contract: launched.contract,
      executionRef: launched.executionRef,
    };
  }
}

/**
 * HTTP-shaped adapter for `POST /admit`. `body` is the already-parsed JSON
 * request payload. Returns { status, body } mirroring a Worker Response so this
 * can be dropped into a fetch handler / Durable Object stub unchanged.
 */
export function handleAdmit(controller, body) {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { admitted: false, reason: "invalid-body" } };
  }
  const result = controller.admit(body);
  return { status: result.status, body: result };
}
