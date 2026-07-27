
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnCapture } from "./core.js";

const WORKTREE_MAX_BYTES = (() => {
  const v = Number(process.env.TERRARIUM_WORKTREE_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024;
})();
const WORKTREE_MAX_FILES = 500;

export async function captureWorktreeSource(cwd, { includeIgnored = false, timeoutMs = 10_000 } = {}) {
  if (!cwd || typeof cwd !== "string") return null;
  const top = await spawnCapture("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs });
  if (top.code !== 0 || top.timedOut) return null;
  const headRes = await spawnCapture("git", ["rev-parse", "HEAD"], { cwd, timeoutMs });
  if (headRes.code !== 0) return null;
  const base = headRes.stdout.trim();

  const diff = await spawnCapture("git", ["diff", "HEAD"], { cwd, timeoutMs });
  if (diff.code !== 0) return null;
  let patch = diff.stdout || "";

  const lsArgs = ["ls-files", "--others", "--exclude-standard"];
  if (includeIgnored) lsArgs.splice(2, 1);
  const untracked = await spawnCapture("git", lsArgs, { cwd, timeoutMs });
  const untrackedFiles = (untracked.stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
  let includeUntracked = false;
  for (const file of untrackedFiles) {
    const add = await spawnCapture("git", ["diff", "--no-index", "--", "/dev/null", file], { cwd, timeoutMs });
    if (add.stdout) { patch += (patch.endsWith("\n") || !patch ? "" : "\n") + add.stdout; includeUntracked = true; }
  }

  if (!patch.trim()) return null;

  const bytes = Buffer.byteLength(patch, "utf8");
  if (bytes > WORKTREE_MAX_BYTES) {
    throw new Error(`worktree patch is ${bytes} bytes, over the ${WORKTREE_MAX_BYTES}-byte cap; commit or reduce the working tree, or raise TERRARIUM_WORKTREE_MAX_BYTES`);
  }
  const files = (patch.match(new RegExp("^diff " + "[-][-]git ", "gm")) || []).length;
  if (files > WORKTREE_MAX_FILES) {
    throw new Error(`worktree patch touches ${files} files, over the ${WORKTREE_MAX_FILES}-file cap`);
  }
  if (/^GIT binary patch$/m.test(patch) || /^Binary files .* differ$/m.test(patch)) {
    throw new Error("worktree contains binary changes, which the patch transport does not support; commit or exclude them");
  }
  const sha256 = createHash("sha256").update(patch).digest("hex");
  return { kind: "patch", patch, base, includeUntracked, includeIgnored, files, bytes, sha256 };
}

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
  let worktreeSource = args.worktreeSource;
  if (!worktreeSource && args.cwd) {
    worktreeSource = await captureWorktreeSource(String(args.cwd), { includeIgnored: args.includeIgnored === true });
  }
  const body = {
    repo,
    ...(Array.isArray(args.commands ?? args.spec?.commands) ? { commands: args.commands ?? args.spec.commands } : {}),
    ...(Array.isArray(args.verify ?? args.spec?.verify) ? { verify: args.verify ?? args.spec.verify } : {}),
    ...(args.artifact ?? args.spec?.artifact ? { artifact: args.artifact ?? args.spec.artifact } : {}),
    ...(Number.isFinite(args.timeoutMs) ? { timeoutMs: Number(args.timeoutMs) } : {}),
    ...(worktreeSource ? { worktreeSource } : {}),
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
