// Thin TypeScript adapter for an optional Go core binary.
//
// Doctrine: this is a *thin* dispatch layer, not a second execution path. When
// TERRARIUM_GO_CORE points at an executable, the adapter shells out to it for a
// deliberately minimal set of read-only / pure operations (version, status,
// dry-run). For every other case — env unset, binary missing, non-zero exit on
// an op the core does not implement, or output that does not parse/validate —
// the adapter falls back to the existing JS implementation. The JS core remains
// the source of truth; the Go core is an accelerator that must prove itself per
// call.
//
// Node (>=22.6 with --experimental-strip-types, >=23.6 by default, native in
// v24) strips these types at import time, so the project stays buildless while
// the contract is expressed in TypeScript.

import { spawnSync } from "node:child_process";
import { VERSION } from "./core.js";

/** Operations the Go core may accelerate. Intentionally minimal. */
export type GoCoreOp = "version" | "status" | "dry-run";

export const GO_CORE_ENV = "TERRARIUM_GO_CORE" as const;

/** Why a given dispatch resolved to JS or Go, for observability and tests. */
export type GoCoreSource = "js" | "go";

export interface GoCoreOutcome<T> {
  /** Which implementation produced the value. */
  source: GoCoreSource;
  /** The op-specific payload. */
  value: T;
  /** Set when the adapter intended to use Go but fell back to JS. */
  fallbackReason?: string;
}

export interface GoCoreVersion {
  version: string;
  core: GoCoreSource;
}

export interface GoCoreRunResult {
  spawned: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Read the configured Go core binary path, or null when disabled. */
export function goCoreBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[GO_CORE_ENV];
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when a Go core binary is configured via TERRARIUM_GO_CORE. */
export function goCoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return goCoreBinary(env) !== null;
}

/**
 * Run the Go core for one op. Pure transport: never throws, captures spawn
 * failures into the result so callers can decide to fall back. The JSON payload
 * (if any) is passed to the binary on stdin and parsed structured output is
 * expected on stdout.
 */
export function invokeGoCore(
  op: GoCoreOp,
  payload: unknown = {},
  env: NodeJS.ProcessEnv = process.env,
): GoCoreRunResult {
  const bin = goCoreBinary(env);
  if (!bin) return { spawned: false, status: null, stdout: "", stderr: "", error: new Error("TERRARIUM_GO_CORE not set") };
  const input = JSON.stringify(payload ?? {});
  const result = spawnSync(bin, [op, "--json"], {
    input,
    encoding: "utf8",
    // Bounded: the minimal ops are fast and synchronous. A hung core must not
    // hang the JS process; on timeout we fall back.
    timeout: 5000,
    env,
  });
  if (result.error) {
    return { spawned: false, status: result.status ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  }
  return { spawned: true, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parseJson<T>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/**
 * version op. Returns the JS VERSION unless the Go core is enabled, succeeds,
 * and reports an identical version string (a compatibility guard so a mismatched
 * core can never silently shadow the JS contract).
 */
export function goCoreVersion(env: NodeJS.ProcessEnv = process.env): GoCoreOutcome<GoCoreVersion> {
  const jsValue: GoCoreVersion = { version: VERSION, core: "js" };
  if (!goCoreEnabled(env)) return { source: "js", value: jsValue };

  const run = invokeGoCore("version", {}, env);
  if (!run.spawned) return { source: "js", value: jsValue, fallbackReason: run.error?.message ?? "spawn failed" };
  if (run.status !== 0) return { source: "js", value: jsValue, fallbackReason: `go core exited ${run.status}` };

  const parsed = parseJson<{ version?: unknown; ok?: unknown; apiVersion?: unknown }>(run.stdout);
  const versionPayload = parsed?.version;
  if (!parsed || !versionPayload || typeof versionPayload !== "object") {
    return { source: "js", value: jsValue, fallbackReason: "unparseable go core version output" };
  }
  const api = (versionPayload as { api?: unknown }).api ?? parsed.apiVersion;
  if (api !== "terrarium-api-2026-06-26") {
    return { source: "js", value: jsValue, fallbackReason: `api mismatch: go=${String(api)} js=terrarium-api-2026-06-26` };
  }
  return { source: "go", value: { version: VERSION, core: "go" } };
}

/**
 * Generic minimal-path dispatcher for status / dry-run. Attempts the Go core
 * and, on any failure, invokes the provided JS fallback. The fallback is only
 * called when needed so its side effects (filesystem reads, etc.) are not
 * duplicated on the Go happy path.
 */
export async function dispatchMinimal<T>(
  op: GoCoreOp,
  payload: unknown,
  jsFallback: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GoCoreOutcome<T>> {
  if (!goCoreEnabled(env)) {
    return { source: "js", value: await jsFallback() };
  }
  const run = invokeGoCore(op, payload, env);
  if (run.spawned && run.status === 0) {
    const parsed = parseJson<T>(run.stdout);
    if (parsed !== null) return { source: "go", value: parsed };
    return { source: "js", value: await jsFallback(), fallbackReason: "unparseable go core output" };
  }
  const reason = !run.spawned ? run.error?.message ?? "spawn failed" : `go core exited ${run.status}`;
  return { source: "js", value: await jsFallback(), fallbackReason: reason };
}
