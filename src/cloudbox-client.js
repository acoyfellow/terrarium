// Cloudbox delegation client.
//
// Terrarium's cloud cell has no operator filesystem, so a repo-grounded task
// (review/test/build against real files) cannot run there and is failed closed
// (see detectFilesystemDependency in cloud-client.js). Cloudbox is the sibling
// system that DOES boot a Cloudflare container with a real Git checkout and
// closes around evidence (clone commit + reproduce/verify command receipts +
// diff + artifact). Per the build-backwards doctrine (don't reinvent a shape
// that already exists), Terrarium DELEGATES repo-grounded work to Cloudbox
// rather than growing its own clone/egress/grant stack.
//
// Terrarium stays the bounded-task + receipt/callback fabric; Cloudbox is the
// grounded cloud computer. This client is the seam between them.
//
// Config (operator-supplied, never hardcoded):
//   CLOUDBOX_URL          e.g. https://cloudbox.coey.dev  (or a local dev slot)
//   CLOUDBOX_TOKEN        Bearer token for Cloudbox (CLOUDBOX_API_TOKEN on that instance)
//   CLOUDBOX_TOKEN_FILE   alternative: path to a file containing the token
//
// Cloudbox contract (verified against cloudbox/src/client.ts + container-runner.ts):
//   POST /api/runs { repo, commands?, verify?, artifact? } + Bearer
//     -> { id, status: "passed"|"failed", receipts[], artifact, proof, live? }

import { readFileSync } from "node:fs";

export function cloudboxConfig(env = process.env) {
  const url = typeof env.CLOUDBOX_URL === "string" ? env.CLOUDBOX_URL.replace(/\/$/, "") : "";
  let token = typeof env.CLOUDBOX_TOKEN === "string" ? env.CLOUDBOX_TOKEN : "";
  if (!token && env.CLOUDBOX_TOKEN_FILE) {
    try { token = readFileSync(env.CLOUDBOX_TOKEN_FILE, "utf8").trim(); } catch { /* leave empty */ }
  }
  return { url, token, configured: Boolean(url) };
}

/** True when a Cloudbox instance is wired for repo-grounded delegation. */
export function cloudboxEnabled(env = process.env) {
  return cloudboxConfig(env).configured;
}

/**
 * Delegate a repo-grounded run to Cloudbox and normalize the result into a
 * Terrarium spawn-shaped envelope so callers/projection stay uniform:
 *   { ok, runId, status, cloudbox: true, repo, commit, passed, receipts, artifact }
 *
 * `spec` accepts { repo, commands, verify, artifact } — repo is required.
 */
export async function cloudboxRun(args = {}, { env = process.env } = {}) {
  const config = cloudboxConfig(env);
  if (!config.url) throw new Error("cloudbox delegation requires CLOUDBOX_URL (and usually CLOUDBOX_TOKEN)");
  const repo = String(args.repo ?? args.spec?.repo ?? "").trim();
  if (!repo) throw new Error("cloudbox run requires a repo (github https URL or an authorized repo key)");
  const body = {
    repo,
    ...(Array.isArray(args.commands ?? args.spec?.commands) ? { commands: args.commands ?? args.spec.commands } : {}),
    ...(Array.isArray(args.verify ?? args.spec?.verify) ? { verify: args.verify ?? args.spec.verify } : {}),
    ...(args.artifact ?? args.spec?.artifact ? { artifact: args.artifact ?? args.spec.artifact } : {}),
    ...(Number.isFinite(args.timeoutMs) ? { timeoutMs: Number(args.timeoutMs) } : {}),
  };
  const res = await fetch(`${config.url}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok || !json || (!json.id && !json.status)) {
    return { ok: false, cloudbox: true, status: "rejected", httpCode: res.status, error: json?.detail || json?.error || json?.raw || `cloudbox run failed (HTTP ${res.status})`, repo };
  }
  const passed = json.status === "passed";
  return {
    ok: passed,
    cloudbox: true,
    runId: json.id ?? json.live?.runId,
    status: passed ? "done" : "failed",
    passed,
    repo,
    commit: json.repo?.commit ?? json.proof?.repo?.commit,
    receipts: json.receipts ?? json.timeline,
    artifact: json.artifact,
    proof: json.proof,
    live: json.live,
  };
}
