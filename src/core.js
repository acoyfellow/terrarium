import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishEvent, eventForRun, TerrariumEventType } from "./event-runtime.js";
import { routeEvent } from "./router.js";
import { initialRunState, transition } from "./run-machine.js";
import { preflightAgentModel, resolveAgentModel } from "./model-resolution.js";

export const VERSION = "0.0.1";
export const HOME = process.env.TERRARIUM_HOME ? resolve(process.env.TERRARIUM_HOME) : join(homedir(), ".terrarium");
export const LOG_DIR = join(HOME, "runs");
export const CONFIG_PATH = join(HOME, "config.json");
export const WORKSPACE_DIR = join(HOME, "workspaces");
export const EVENT_DIR = join(HOME, "events");

function cancelMarkerPath(runId) { return join(LOG_DIR, `${assertRunId(runId)}.cancel`); }
function signalProcessGroup(pid, signal) {
  if (!pid) return;
  try { process.kill(-Number(pid), signal); }
  catch { try { process.kill(Number(pid), signal); } catch {} }
}

export function splitCommand(command) {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "")) ?? [];
}

export function makeRunId() {
  return `ter_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${Math.random().toString(36).slice(2, 8)}`;
}

export const PROMPT_PROFILES = ["default", "minimal"];
export const DEFAULT_PROMPT_PROFILE = "default";

export const READ_ONLY_AGENT = "opencode run --agent explore";
export const ACCESS_SCOPES = ["self", "descendants", "all"];
// Keep prompts below conservative argv limits; larger prompts move through a private file.
export const PROMPT_ARG_MAX_BYTES = 24 * 1024;

function envBoolean(value) {
  if (value == null || value === "") return null;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new Error("invalid boolean capability value");
}

function accessScope(value, fallback) {
  const scope = value || fallback;
  if (!ACCESS_SCOPES.includes(scope)) throw new Error(`invalid Terrarium access scope: ${scope}`);
  return scope;
}

export function taskFingerprint(task) {
  return createHash("sha256").update(String(task)).digest("hex").slice(0, 24);
}

export function classifyRunnerFailure({ agent, stdoutTail, stderrTail, error } = {}) {
  const parts = splitCommand(agent || "");
  const executable = basename(parts[0] || "");
  const output = [stderrTail, stdoutTail, error].filter(Boolean).join("\n");
  if (executable === "pi" && /\b(?:runner|agent)\s+(?:is\s+)?busy\b|\bno\s+available\s+runners?\b|agent is already processing|specify streamingBehavior/i.test(output)) {
    return { failureKind: "runner-busy", retryable: true };
  }
  if (executable === "opencode" && parts[1] === "run" && /model(?:\s+\S+)?\s+(?:not found|does not exist|is not available|is invalid)|unknown model|invalid model|provider\/model|model.*(?:configuration|config).*(?:invalid|missing)/i.test(output)) {
    return { failureKind: "model-configuration", retryable: false };
  }
  return null;
}

export function resolveModel({ model } = {}, { env = process.env, config = {} } = {}) {
  return model || env.TERRARIUM_MODEL || config.defaultModel || null;
}

/**
 * Add a first-class model to supported agent commands without requiring every
 * caller to know each runner's CLI shape. Unknown commands remain available
 * through --agent, but must carry their own model flag.
 */
export function applyModelToAgent(agent, model, { strict = true, provider = null } = {}) {
  if (!model) return agent;
  const parts = splitCommand(agent);
  const executable = basename(parts[0] || "");
  const isOpenCodeRun = executable === "opencode" && parts[1] === "run";
  const isPi = executable === "pi";
  if (!isOpenCodeRun && !isPi) {
    if (!strict) return agent;
    throw new Error(`--model is supported for 'opencode run' and 'pi' agents; include the model flag directly in --agent for: ${agent}`);
  }
  if (parts.includes("--model") || parts.includes("-m")) {
    throw new Error("agent command already contains a model flag; use either --model or an inline model, not both");
  }
  if (provider && isPi) {
    const providerIndex = parts.findIndex((part) => part === "--provider");
    if (providerIndex >= 0) {
      if (parts[providerIndex + 1] !== provider) throw new Error("agent provider does not match the resolved provider");
      return [...parts, "--model", model].map(shellToken).join(" ");
    }
    return [...parts, "--provider", provider, "--model", model].map(shellToken).join(" ");
  }
  return [...parts, "--model", model].map(shellToken).join(" ");
}

function shellToken(value) {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function modelFlagInAgent(agent) {
  const parts = splitCommand(agent);
  const index = parts.findIndex((part) => part === "--model" || part === "-m");
  return index >= 0 ? parts[index + 1] ?? null : null;
}

export function resolvePromptProfile(profile) {
  if (profile == null || profile === "") return DEFAULT_PROMPT_PROFILE;
  if (!PROMPT_PROFILES.includes(profile)) throw new Error(`unknown prompt profile: ${profile} (expected one of: ${PROMPT_PROFILES.join(", ")})`);
  return profile;
}

export function resolveAgent({ agent, readOnly } = {}, { env = process.env, config = {} } = {}) {
  if (agent) return agent;
  if (readOnly) return env.TERRARIUM_READ_ONLY_AGENT || config.readOnlyAgent || READ_ONLY_AGENT;
  if (env.TERRARIUM_AGENT) return env.TERRARIUM_AGENT;
  if (config.defaultAgent) return config.defaultAgent;
  return "opencode run";
}

export function childPrompt(task, opts = {}) {
  const { depth, maxDepth, runId, parentRunId, profile, allowSpawn = true, taskContract } = opts;
  const resolved = resolvePromptProfile(profile);
  const contractLine = taskContract ? `TERRARIUM_RESULT=${JSON.stringify({ runId: taskContract.runId, taskFingerprint: taskContract.taskFingerprint, nonce: taskContract.nonce, summary: "brief task-specific result" })}` : "";
  const contract = taskContract ? `\nYour final output MUST include exactly one line:\n${contractLine}` : "";
  const contractReminder = taskContract ? `\n\nFinish by emitting the TERRARIUM_RESULT= line above as your last line.` : "";
  if (resolved === "minimal") {
    return `Terrarium child. Single bounded task. Do not spawn subagents.\n${allowSpawn ? "One explicit Terrarium child call is available only if the task requires it." : "Terrarium recursion is disabled; do not call Terrarium tools."}

Do the assigned task directly. Do not inspect unrelated Terrarium runs, callbacks, logs, or other agents.
Reply with: Summary, Changed files, Verification.${contract}

Task:
${task}${contractReminder}`;
  }
  return `You are a Terrarium child agent.

Rules:
- Complete exactly the delegated task directly.
- ${allowSpawn ? "You may call Terrarium at most once." : "Terrarium recursion is disabled; do not call Terrarium tools."}
- Do not inspect unrelated Terrarium runs, callbacks, logs, or other agents.
- Do not fan out.
- Current Terrarium depth: ${depth ?? 1}/${maxDepth ?? 3}.
- Run ID: ${runId ?? "unknown"}.
- Parent run ID: ${parentRunId ?? "none"}.

Return in this shape:
Summary:
Changed files:
Verification:
Follow-ups:${contract}

Task:
${task}${contractReminder}`;
}

export async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
}

export function assertRunId(runId) {
  if (typeof runId !== "string" || !/^ter_[A-Za-z0-9_]+$/.test(runId)) throw new Error("invalid Terrarium run id");
  return runId;
}

function correlationValue(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/.test(value)) throw new Error(`invalid Terrarium ${label}`);
  return value;
}

function confinedLogPath(path, label = "log path") {
  const root = resolve(LOG_DIR);
  const candidate = resolve(path);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) throw new Error(`${label} must stay inside the Terrarium log directory`);
  return candidate;
}

export async function defaultLogPath(runId) {
  assertRunId(runId);
  await mkdir(LOG_DIR, { recursive: true });
  return join(LOG_DIR, `${runId}.log`);
}

export async function defaultMreLogPath(runId) {
  assertRunId(runId);
  await mkdir(LOG_DIR, { recursive: true });
  return join(LOG_DIR, `${runId}.mre.log`);
}

export function metadataPath(runId) {
  assertRunId(runId);
  return join(LOG_DIR, `${runId}.json`);
}

async function log(path, line) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line);
}

export async function spawnCapture(cmd, args, opts = {}) {
  const { timeoutMs, ...spawnOpts } = opts;
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...spawnOpts });
    let stdout = "";
    let stderr = "";
    let timer = null;
    // Bound the call so a slow subprocess (e.g. `git status` on a huge tree)
    // cannot block the caller indefinitely. On timeout, kill the process group
    // and resolve with a non-zero code + a timed-out marker rather than hanging.
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve({ code: 124, signal: "SIGKILL", timedOut: true, stdout, stderr: stderr + `\n[spawnCapture] ${cmd} exceeded ${timeoutMs}ms` });
      }, timeoutMs);
      timer.unref?.();
    }
    child.stdout?.on("data", (d) => stdout += String(d));
    child.stderr?.on("data", (d) => stderr += String(d));
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr + e.message }); });
    child.on("close", (code, signal) => { if (timer) clearTimeout(timer); resolve({ code: code ?? (signal ? 128 : 0), signal, stdout, stderr }); });
  });
}

function tail(text, max = 12000) {
  return text.length > max ? text.slice(-max) : text;
}

// Bounded git call. `git status --short` on a huge working tree (e.g. a 98GB
// monorepo cwd) can take many seconds and BLOCK the caller. Because gitInfo runs
// synchronously inside prepareRun BEFORE the durable accept-receipt is returned,
// a slow git there stalls the whole spawn past the MCP host's RPC deadline ->
// `-32001 Request timed out` with NO runId (the exact MCP-vs-CLI boundary in the
// 2026-07-24 incident: the native CLI has no RPC deadline, so it just waits).
// git metadata is advisory, not load-bearing, so a timeout returns null rather
// than blocking. Default 3s; override with TERRARIUM_GIT_INFO_TIMEOUT_MS.
const GIT_INFO_TIMEOUT_MS = (() => {
  const v = Number(process.env.TERRARIUM_GIT_INFO_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 3000;
})();
async function gitOutput(cwd, args, timeoutMs = GIT_INFO_TIMEOUT_MS) {
  const r = await spawnCapture("git", args, { cwd, timeoutMs });
  return r.code === 0 ? r.stdout.trim() : null;
}

async function gitRoot(cwd) {
  return gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
}

async function gitInfo(cwd) {
  const [root, head, status] = await Promise.all([
    gitOutput(cwd, ["rev-parse", "--show-toplevel"]),
    gitOutput(cwd, ["rev-parse", "HEAD"]),
    gitOutput(cwd, ["status", "--short"]),
  ]);
  if (!root) return null;
  return { root, head, status };
}

async function writeMetadata(meta) {
  await mkdir(LOG_DIR, { recursive: true });
  const target = metadataPath(meta.runId);
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temp, JSON.stringify(meta, null, 2) + "\n", { flag: "wx" });
  await rename(temp, target);
}

const MAX_PROOF_OUTPUT_BYTES = 4 * 1024;
const DEFAULT_PROOF_TIMEOUT_MS = 120_000;

export async function runTaskProof(proof, { cwd, timeoutMs = DEFAULT_PROOF_TIMEOUT_MS } = {}) {
  if (proof == null) return { status: "not-required" };
  if (typeof proof !== "string" || !proof.trim()) return { status: "invalid", reason: "proof must be a non-empty shell command" };
  const command = proof.trim();
  const result = await spawnCapture("/bin/sh", ["-c", command], { cwd, timeoutMs });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-MAX_PROOF_OUTPUT_BYTES);
  if (result.timedOut) return { status: "timeout", command, exitCode: result.code, output };
  if (result.code !== 0) return { status: "failed", command, exitCode: result.code, output };
  return { status: "proved", command, exitCode: 0, output };
}

export function findUnisolatedCoWriters({ runs = [], cwd, isolation = "none", readOnly = false } = {}) {
  if (readOnly || isolation !== "none" || !cwd) return [];
  return runs
    .filter((run) => run.status === "running" && run.alive !== false)
    .filter((run) => (run.isolation ?? "none") === "none" && !run.readOnly)
    .filter((run) => (run.cwd ?? run.originalCwd) === cwd)
    .map((run) => run.runId);
}

export async function recordCloudAdmission({ runId, channel = null, workflowId = null, task = "", model = null, contract = null, executionRef = null, background = false } = {}) {
  assertRunId(runId);
  if (existsSync(metadataPath(runId))) return { runId, persisted: false };
  const startedAt = new Date().toISOString();
  await writeMetadata({
    runId,
    parentRunId: process.env.TERRARIUM_RUN_ID || null,
    version: VERSION,
    cloud: true,
    status: "running",
    background,
    progressText: "admitted",
    startedAt,
    lastActivityAt: startedAt,
    channel,
    workflowId,
    task,
    model,
    executionRef,
    taskFingerprint: contract?.taskFingerprint ?? taskFingerprint(task),
    taskContractStatus: "pending",
    taskContract: contract ?? null,
  });
  return { runId, persisted: true };
}

function buildRun(opts, config) {
  const runId = assertRunId(opts.runId || makeRunId());
  const inheritedParent = process.env.TERRARIUM_RUN_ID || null;
  if (opts.parentRunId && inheritedParent && opts.parentRunId !== inheritedParent) throw new Error("parent run id does not match inherited parent");
  const parentRunId = opts.parentRunId || inheritedParent;
  if (parentRunId) assertRunId(parentRunId);
  const inheritedDepth = Number(process.env.TERRARIUM_DEPTH ?? 0);
  const requestedDepth = Number(opts.depth ?? inheritedDepth);
  if (!Number.isInteger(requestedDepth) || requestedDepth < inheritedDepth || requestedDepth < 0) throw new Error("invalid Terrarium depth");
  const depth = requestedDepth + 1;
  const inheritedMax = process.env.TERRARIUM_MAX_DEPTH ? Number(process.env.TERRARIUM_MAX_DEPTH) : null;
  const requestedMax = Number(opts.maxDepth ?? inheritedMax ?? config.maxDepth ?? 3);
  if (!Number.isInteger(requestedMax) || requestedMax < 1) throw new Error("invalid Terrarium max depth");
  if (inheritedMax !== null && requestedMax > inheritedMax) throw new Error("child cannot raise inherited Terrarium max depth");
  const maxDepth = requestedMax;
  const requestedReadOnly = Boolean(opts.readOnly ?? config.readOnly ?? false);
  const baseAgent = resolveAgent({ agent: opts.agent, readOnly: requestedReadOnly }, { env: process.env, config });
  const requestedModel = resolveModel({ model: opts.model }, { env: process.env, config });
  const modelResolution = resolveAgentModel({ agent: baseAgent, model: requestedModel, provider: opts.provider }, { env: process.env, config });
  const appliedAgent = applyModelToAgent(baseAgent, modelResolution.model, { strict: Boolean(opts.model), provider: modelResolution.provider });
  const model = appliedAgent === baseAgent ? modelFlagInAgent(appliedAgent) : modelResolution.model;
  const provider = modelResolution.provider;
  let agent = appliedAgent;
  const agentParts = splitCommand(agent);
  if (basename(agentParts[0] || "") === "pi" && !agentParts.includes("--no-session") && !agentParts.includes("--session") && !agentParts.includes("--session-id") && opts.ephemeral !== false) {
    agent = [...agentParts, "--no-session"].map(shellToken).join(" ");
  } else if (basename(agentParts[0] || "") === "pi" && (agentParts.includes("--session") || agentParts.includes("--session-id")) && !agentParts.includes("--print") && !agentParts.includes("-p")) {
    agent = [...agentParts, "--print"].map(shellToken).join(" ");
  }
  const readOnly = requestedReadOnly && !opts.agent;
  const profile = resolvePromptProfile(opts.profile ?? config.profile);
  const timeoutMs = Number(opts.timeoutMs ?? config.timeoutMs ?? 0);
  const { task, dryRun = false, cwd = process.cwd(), stream = true } = opts;
  const isolation = opts.isolation || config.isolation || "none";
  const keepWorkspace = Boolean(opts.keepWorkspace ?? config.keepWorkspace ?? false);
  const logPath = opts.logPath ? confinedLogPath(opts.logPath) : opts.logPath;
  const mreLogPath = opts.mreLogPath ? confinedLogPath(opts.mreLogPath, "MRE log path") : opts.mreLogPath;
  const inheritedAllowSpawn = envBoolean(process.env.TERRARIUM_ALLOW_SPAWN);
  const requestedAllowSpawn = envBoolean(opts.allowSpawn ?? config.allowSpawn);
  if (inheritedAllowSpawn === false && requestedAllowSpawn === true) throw new Error("child cannot enable inherited Terrarium spawn capability");
  const callerSpawnAllowed = inheritedAllowSpawn !== false;
  const allowSpawn = requestedAllowSpawn ?? (profile !== "minimal" && depth < maxDepth);
  const inheritedStatusScope = process.env.TERRARIUM_STATUS_SCOPE;
  const inheritedReadScope = process.env.TERRARIUM_READ_SCOPE;
  const requestedStatusScope = accessScope(opts.statusScope ?? config.statusScope, inheritedStatusScope || (allowSpawn ? "descendants" : "self"));
  const requestedReadScope = accessScope(opts.readScope ?? config.readScope, inheritedReadScope || (allowSpawn ? "descendants" : "self"));
  const scopeRank = (scope) => ACCESS_SCOPES.indexOf(scope);
  if (inheritedStatusScope && scopeRank(requestedStatusScope) > scopeRank(accessScope(inheritedStatusScope, "self"))) throw new Error("child cannot widen inherited status scope");
  if (inheritedReadScope && scopeRank(requestedReadScope) > scopeRank(accessScope(inheritedReadScope, "self"))) throw new Error("child cannot widen inherited read scope");
  const statusScope = inheritedStatusScope ? accessScope(inheritedStatusScope, "self") : requestedStatusScope;
  const readScope = inheritedReadScope ? accessScope(inheritedReadScope, "self") : requestedReadScope;
  const requireTaskContract = Boolean(opts.requireTaskContract ?? config.requireTaskContract ?? false);
  const taskContract = requireTaskContract ? { runId, taskFingerprint: taskFingerprint(task), nonce: randomUUID() } : null;
  const taskProof = typeof opts.taskProof === "string" && opts.taskProof.trim() ? opts.taskProof.trim() : null;
  const needsAttentionAfterMs = Number(opts.needsAttentionAfterMs ?? config.needsAttentionAfterMs ?? 60000);
  if (!Number.isFinite(needsAttentionAfterMs) || needsAttentionAfterMs < 5000 || needsAttentionAfterMs > 3600000) throw new Error("needsAttentionAfterMs must be between 5000 and 3600000");
  // pi -p buffers its first stdout until task completion. Five minutes leaves room for
  // a real cold start while the caller's task deadline remains the hard upper bound.
  const startupWatchdogMs = Number(opts.startupWatchdogMs ?? process.env.TERRARIUM_STARTUP_WATCHDOG_MS ?? config.startupWatchdogMs ?? 300000);
  if (!Number.isFinite(startupWatchdogMs) || startupWatchdogMs < 0 || startupWatchdogMs > 3600000) throw new Error("startupWatchdogMs must be between 0 and 3600000");
  const callerChannel = basename(process.cwd()).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "default";
  const channel = correlationValue(opts.channel ?? process.env.TERRARIUM_EVENT_CHANNEL ?? callerChannel, "channel");
  const workflowId = correlationValue(opts.workflowId ?? parentRunId ?? runId, "workflow id");
  const sessionId = correlationValue(opts.sessionId ?? process.env.TERRARIUM_SESSION_ID ?? null, "session id");
  return { runId, parentRunId, depth, maxDepth, agent, model, provider, modelResolution, profile, readOnly, timeoutMs, task, dryRun, cwd, originalCwd: cwd, stream, logPath, mreLogPath, isolation, keepWorkspace, callerSpawnAllowed, allowSpawn, statusScope, readScope, requireTaskContract, taskContract, taskProof, needsAttentionAfterMs, startupWatchdogMs, channel, workflowId, sessionId };
}

async function workspaceExcludes() {
  return new Set([".git", "node_modules", ".next", "dist", "build", "target", "coverage", ".terrarium-workspace"]);
}

function workspaceMarker(run, isolation, extra = {}) {
  return { runId: run.runId, isolation, ...extra };
}

export async function prepareWorkspace(run) {
  if (!run.isolation || run.isolation === "none") return null;
  await mkdir(WORKSPACE_DIR, { recursive: true });
  if (run.isolation === "copy") {
    const workspacePath = join(WORKSPACE_DIR, `${run.runId}-${basename(run.originalCwd)}`);
    await rm(workspacePath, { recursive: true, force: true });
    const excludes = await workspaceExcludes();
    await cp(run.originalCwd, workspacePath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: (src) => !excludes.has(basename(src)),
    });
    await writeFile(join(workspacePath, ".terrarium-workspace"), JSON.stringify(workspaceMarker(run, "copy"), null, 2) + "\n");
    run.cwd = workspacePath;
    return { type: "copy", path: workspacePath, source: run.originalCwd, cleanup: !run.keepWorkspace };
  }
  if (run.isolation === "worktree") {
    const root = await gitRoot(run.originalCwd);
    if (!root) throw new Error("--isolation worktree requires a git repository");
    const workspacePath = join(WORKSPACE_DIR, `${run.runId}-${basename(root)}`);
    const branch = `terrarium/${run.runId}`;
    await rm(workspacePath, { recursive: true, force: true });
    const r = await spawnCapture("git", ["worktree", "add", "-b", branch, workspacePath], { cwd: root });
    if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`.trim());
    await writeFile(join(workspacePath, ".terrarium-workspace"), JSON.stringify(workspaceMarker(run, "worktree", { branch }), null, 2) + "\n");
    run.cwd = workspacePath;
    return { type: "worktree", path: workspacePath, source: root, branch, cleanup: !run.keepWorkspace };
  }
  throw new Error(`unknown isolation mode: ${run.isolation}`);
}

export async function capturePatch(workspacePath) {
  await spawnCapture("git", ["add", "-A", "--", ":(exclude).terrarium-workspace", ":(exclude)**/.terrarium-workspace"], { cwd: workspacePath });
  return await spawnCapture("git", ["diff", "--cached", "--binary", "--", ":(exclude).terrarium-workspace", ":(exclude)**/.terrarium-workspace"], { cwd: workspacePath });
}

export async function removeWorktree(workspace) {
  const remove = await spawnCapture("git", ["worktree", "remove", "--force", workspace.path], { cwd: workspace.source });
  if (remove.code !== 0) {
    await rm(workspace.path, { recursive: true, force: true });
    await spawnCapture("git", ["worktree", "prune"], { cwd: workspace.source });
  }
  if (workspace.branch) await spawnCapture("git", ["branch", "-D", workspace.branch], { cwd: workspace.source });
}

export async function finalizeWorkspace(workspace, resultPatch) {
  if (!workspace) return {};
  const out = { workspace };
  const diff = await capturePatch(workspace.path);
  if (diff.code === 0 && diff.stdout) {
    const patchPath = join(LOG_DIR, `${resultPatch.runId}.patch`);
    await writeFile(patchPath, diff.stdout);
    out.patchPath = patchPath;
    out.patchBytes = Buffer.byteLength(diff.stdout);
  }
  if (workspace.cleanup) {
    if (workspace.type === "worktree") await removeWorktree(workspace);
    else await rm(workspace.path, { recursive: true, force: true });
  }
  return out;
}

async function claimChildSlot(run) {
  if (!run.parentRunId) return null;
  const budget = Number(process.env.TERRARIUM_CHILD_BUDGET ?? 1);
  if (!Number.isInteger(budget) || budget < 0 || budget > 100) throw new Error("invalid Terrarium child budget");
  const claimsDir = join(LOG_DIR, `${run.parentRunId}.children`);
  await mkdir(claimsDir, { recursive: true });
  for (let slot = 1; slot <= budget; slot++) {
    const claimPath = join(claimsDir, String(slot));
    try { await writeFile(claimPath, run.runId, { flag: "wx" }); return claimPath; } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  throw new Error(`Terrarium child budget exceeded (${budget})`);
}

async function releaseChildSlot(claimPath) {
  if (!claimPath) return;
  await rm(claimPath, { force: true });
  try { await rmdir(dirname(claimPath)); } catch {}
}

// A child-slot claim is stale when its contents are not a valid run id or the
// referenced run log no longer exists (e.g. the child was pruned, or the
// supervisor died during the launch handoff before it could ever write the
// log). A stale claim permanently occupies one of the parent's bounded child
// slots, so doctor flags them. This is the mechanical remediation doctor's
// repairPlan points at: it removes only claims that match doctor's staleness
// criteria exactly, never a slot held by a live run log, and garbage-collects
// any `.children` directory it empties. Top-level controller only.
export async function pruneStaleChildClaims({ requesterRunId } = {}) {
  if (requesterRunId || process.env.TERRARIUM_RUN_ID) throw new Error("child-slot claim pruning is available only to a top-level controller");
  const pruned = [];
  let entries = [];
  try { entries = await readdir(LOG_DIR); } catch { return { pruned, count: 0 }; }
  for (const entry of entries) {
    if (!entry.endsWith(".children")) continue;
    const dir = join(LOG_DIR, entry);
    let slots = [];
    try { slots = await readdir(dir); } catch { continue; }
    for (const slot of slots) {
      const claimFile = join(dir, slot);
      let childId = "";
      try { childId = (await readFile(claimFile, "utf8")).trim(); } catch {}
      const stale = !/^ter_[A-Za-z0-9_]+$/.test(childId) || !existsSync(metadataPath(childId));
      if (!stale) continue;
      try { await rm(claimFile, { force: true }); pruned.push({ claimFile, childRunId: childId || null }); }
      catch {}
    }
    try { await rmdir(dir); } catch {}
  }
  return { pruned, count: pruned.length };
}

async function prepareRun(opts = {}) {
  const config = opts.config ?? await loadConfig();
  const run = buildRun(opts, config);
  // All non-mutating validation must happen before a child slot is claimed.
  if (!run.task) throw new Error("missing task");
  if (!run.dryRun) {
    const preflight = preflightAgentModel(run.modelResolution, { env: process.env, agent: run.agent });
    if (!preflight.ok) throw new Error(preflight.message);
    run.modelCredentialSource = preflight.credentialSource;
  }
  if (run.depth > run.maxDepth) throw new Error(`Terrarium max depth exceeded (${run.depth}/${run.maxDepth})`);
  if (run.parentRunId && !run.callerSpawnAllowed) throw new Error("Terrarium spawn capability denied for this child");
  const parts = splitCommand(run.agent);
  if (parts.length === 0) throw new Error("empty agent command");
  // Durable accept-receipt BEFORE any slow launch work (workspace copy, git info).
  // The runId is already minted; persisting a minimal `accepted` record here means
  // that even if the caller's spawn RPC later times out during a slow handshake
  // (large --isolation copy, slow git, load), the run is still discoverable via
  // listRuns/terrarium_status (incl. the channel/workflowId/sinceMs recovery
  // filters) instead of being lost. A background run overwrites this with full
  // metadata once launched; a synchronous run does the same. Best-effort: never
  // let receipt persistence failure block the run.
  if (!run.dryRun) {
    try {
      run.logPath ??= await defaultLogPath(run.runId);
      await writeMetadata({
        runId: run.runId, parentRunId: run.parentRunId, version: VERSION, agent: run.agent,
        model: run.model, provider: run.provider, task: run.task, cwd: run.cwd, originalCwd: run.originalCwd,
        modelCredentialSource: run.modelCredentialSource ?? null, isolation: run.isolation, logPath: run.logPath, startedAt: new Date().toISOString(),
        status: "accepted", channel: run.channel, workflowId: run.workflowId, sessionId: run.sessionId,
        taskFingerprint: run.taskContract?.taskFingerprint ?? taskFingerprint(run.task),
      });
    } catch { /* best effort; full metadata is written below */ }
  }
  const workspace = await prepareWorkspace(run);
  const prompt = childPrompt(run.task, run);
  run.logPath ??= await defaultLogPath(run.runId);
  run.mreLogPath ??= await defaultMreLogPath(run.runId);
  const startedAt = new Date().toISOString();
  const base = { runId: run.runId, parentRunId: run.parentRunId, depth: run.depth, maxDepth: run.maxDepth, version: VERSION, agent: run.agent, model: run.model, provider: run.provider, modelCredentialSource: run.modelCredentialSource ?? null, profile: run.profile, readOnly: run.readOnly, task: run.task, cwd: run.cwd, originalCwd: run.originalCwd, isolation: run.isolation, workspace, logPath: run.logPath, mreLogPath: run.mreLogPath, startedAt, lastActivityAt: startedAt, progressText: "started", needsAttentionAfterMs: run.needsAttentionAfterMs, status: "running", git: await gitInfo(run.cwd), allowSpawn: run.allowSpawn, statusScope: run.statusScope, readScope: run.readScope, channel: run.channel, workflowId: run.workflowId, sessionId: run.sessionId, taskFingerprint: run.taskContract?.taskFingerprint ?? taskFingerprint(run.task), taskContractStatus: run.requireTaskContract ? "pending" : "not-required", taskContract: run.taskContract, taskProof: run.taskProof ?? null };
  let claimPath = null;
  try {
    claimPath = await claimChildSlot(run);
    await writeMetadata(base);
    const header = `terrarium ${VERSION}\nrun: ${run.runId}\nparent: ${run.parentRunId ?? "none"}\ndepth: ${run.depth}/${run.maxDepth}\nagent: ${run.agent}${run.readOnly ? " (read-only preset)" : ""}\nprovider: ${run.provider ?? "runner default"}\nmodel: ${run.model ?? "runner default"}\nprofile: ${run.profile}\ntask: ${run.task}\ncwd: ${run.cwd}\noriginal cwd: ${run.originalCwd}\nisolation: ${run.isolation}${workspace ? ` (${workspace.path})` : ""}\nlog: ${run.logPath}\nmre log: ${run.mreLogPath}\n\n`;
    if (run.stream) process.stdout.write(header);
    await writeFile(run.logPath, header);
    await writeFile(run.mreLogPath, "", { flag: "wx" });
    return { run, parts, prompt, base, workspace, claimPath };
  } catch (error) {
    await releaseChildSlot(claimPath);
    try { await rm(metadataPath(run.runId), { force: true }); } catch {}
    try { await rm(run.logPath, { force: true }); } catch {}
    if (workspace?.cleanup) {
      try { workspace.type === "worktree" ? await removeWorktree(workspace) : await rm(workspace.path, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}

async function emitProgressEvent(run, text, { activity = true } = {}) {
  try {
    if (activity) {
      const current = await readMetadata(run.runId);
      if (current.status === "running") await writeMetadata({ ...current, lastActivityAt: new Date().toISOString(), progressText: String(text).slice(-300) });
    }
    const channel = run.channel ?? process.env.TERRARIUM_EVENT_CHANNEL;
    const event = { type: "terrarium.progress", runId: run.runId, cwd: run.originalCwd ?? run.cwd, task: run.task, text, at: new Date().toISOString(), channel: channel ?? null };
    const typed = eventForRun(TerrariumEventType.Progress, run, { text, channel: run.channel ?? basename(run.originalCwd ?? run.cwd) });
    await publishEvent(typed);
    // Progress is high-frequency and already persisted as latest-run metadata
    // plus one channel progress file. Durable callback mailboxes are reserved
    // for terminal lifecycle events; routing 3-second heartbeats created an
    // unbounded queue that buried completion signals.
    if (!channel) return;
    const dir = join(EVENT_DIR, channel);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${run.runId}.progress.json`), `${JSON.stringify(event)}\n`);
  } catch {}
}

async function emitCompletionEvent(result) {
    const channel = result.channel ?? process.env.TERRARIUM_EVENT_CHANNEL;
    const event = {
      type: "terrarium.completed",
      runId: result.runId,
      status: result.status,
      ok: result.ok,
      exitCode: result.exitCode,
      signal: result.signal ?? null,
      dryRun: result.dryRun === true,
      taskFingerprint: result.taskFingerprint ?? null,
      finishedAt: result.finishedAt,
      channel: channel ?? null,
    };
    const completionType = result.status === "cancelled" ? TerrariumEventType.Cancelled : result.ok ? TerrariumEventType.Completed : TerrariumEventType.Failed;
    const typed = eventForRun(completionType, result, {
      channel: result.channel ?? basename(result.originalCwd ?? result.cwd),
      status: result.status,
      ok: result.ok,
      exitCode: result.exitCode,
      signal: result.signal ?? null,
      dryRun: result.dryRun === true,
    });
    // Persist and route first. The in-process Effect bus and legacy channel
    // mirror are secondary observers and must never prevent durable callbacks.
    const routed = await routeEvent(typed);
    try { await publishEvent(typed); } catch {}
    if (channel) {
      try {
        const dir = join(EVENT_DIR, channel);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${result.runId}.json`), `${JSON.stringify(event)}\n`, { flag: "wx" });
      } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    // Link the authoritative run envelope to the durable callback journal entry.
    // The callback is still only a notification, but this handle lets operators
    // reconstruct delivery/routing state without trusting child prose.
    try {
      const path = metadataPath(result.runId);
      const current = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, `${JSON.stringify({
        ...current,
        terminalCallback: { eventId: routed.eventId, delivered: routed.delivered, duplicate: routed.duplicate === true },
      }, null, 2)}\n`);
    } catch {}
    return routed;
}

const TASK_RESULT_MARKER = "TERRARIUM_RESULT=";
const MAX_TASK_RESULT_LINE_BYTES = 16 * 1024;
const TASK_RESULT_KEYS = new Set(["runId", "taskFingerprint", "nonce", "summary"]);

export function validateTaskContractOutput(output, expected) {
  if (!expected) return { status: "not-required" };
  const lines = String(output ?? "").split(/[\n\r\u2028\u2029]/).filter((value) => value.startsWith(TASK_RESULT_MARKER));
  if (lines.length === 0) return { status: "missing" };
  if (lines.length !== 1 || Buffer.byteLength(lines[0], "utf8") > MAX_TASK_RESULT_LINE_BYTES) return { status: "malformed" };
  let receipt;
  try { receipt = JSON.parse(lines[0].slice(TASK_RESULT_MARKER.length)); }
  catch { return { status: "malformed" }; }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return { status: "malformed" };
  if (Object.keys(receipt).some((key) => !TASK_RESULT_KEYS.has(key))) return { status: "malformed" };
  if (receipt.runId !== expected.runId || receipt.taskFingerprint !== expected.taskFingerprint || receipt.nonce !== expected.nonce) return { status: "mismatch" };
  if (typeof receipt.summary !== "string" || !receipt.summary.trim() || receipt.summary.length > 2000) return { status: "malformed" };
  return { status: "verified", summary: receipt.summary.trim() };
}

async function persistFinishedRun(base, patch) {
  let result = { ...base, ...patch, finishedAt: patch.finishedAt ?? new Date().toISOString() };
  if (!result.ok) {
    const classification = classifyRunnerFailure(result);
    if (classification) result = { ...result, ...classification };
  }
  if (patch.taskContractStatus != null) {
    // A run-machine adapter already made the contract/terminal decision.
  } else if (patch.dryRun === true && base.taskContractStatus === "pending") result.taskContractStatus = "not-applicable";
  else if (base.taskContractStatus === "pending") {
    // Validate the receipt against the FULL captured stdout, not the bounded
    // display tail. A child can legitimately emit its TERRARIUM_RESULT line and
    // then print more than the tail window of trailing output; scanning only the
    // tail would drop a genuine receipt and misreport a verified run as missing.
    const contractOutput = patch.contractOutput != null ? patch.contractOutput : result.stdoutTail;
    const contract = validateTaskContractOutput(contractOutput, base.taskContract);
    result.taskContractStatus = contract.status;
    if (contract.summary) result.taskResultSummary = contract.summary;
    if (contract.status !== "verified") result = { ...result, ok: false, status: result.exitCode === 0 ? "inconclusive" : result.status, note: `Task contract ${contract.status}; process exit is not accepted as task success.` };
    else if (base.taskProof != null) {
      const proof = await runTaskProof(base.taskProof, { cwd: base.originalCwd ?? base.cwd });
      result.taskProofStatus = proof.status;
      result.taskProof = { command: proof.command ?? null, exitCode: proof.exitCode ?? null, output: proof.output ?? null };
      if (proof.status !== "proved") {
        result = {
          ...result,
          ok: false,
          status: "inconclusive",
          taskContractStatus: "unproven",
          note: `The child reported success, but the operator proof command ${proof.status}. A self-reported receipt is a claim; the proof is the evidence.`,
        };
      }
    }
  }
  delete result.contractOutput;
  delete result.taskContract;
  await writeMetadata(result);
  return result;
}

async function finishRun(base, patch) {
  const result = await persistFinishedRun(base, patch);
  await emitCompletionEvent(result);
  return result;
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export async function readMetadata(runId) {
  return JSON.parse(await readFile(metadataPath(runId), "utf8"));
}

export async function reconcileRun(meta, { staleMs = 30000 } = {}) {
  // An `accepted` record is a durable pre-launch receipt (runId persisted before
  // the slow launch handshake, so a timed-out spawn RPC is still recoverable). If
  // a spawn crashed between accept and launch, the record would otherwise linger
  // as `accepted` forever. Reconcile a stale accepted (no live process, older than
  // staleMs) to `orphaned` so status does not report perpetual pending work. A
  // fresh accepted (still mid-launch) is left as-is.
  if (meta && meta.status === "accepted") {
    const startedTs = Date.parse(meta.startedAt ?? "");
    const stale = !Number.isFinite(startedTs) || (Date.now() - startedTs) >= staleMs;
    const anyAlive = isPidAlive(meta.supervisorPid) || [meta.pid, meta.childPid, meta.runnerPid].filter(Boolean).some(isPidAlive);
    if (stale && !anyAlive) {
      // The spawn died between the accept-receipt and launch (no supervisor/child
      // ever came up). This IS terminal, so it must PERSIST and EMIT a terminal
      // callback — otherwise a caller waiting on the callback hangs forever (the
      // "callbacks not working" symptom). Mirror the running->orphaned path:
      // write the durable terminal record + fire the completion event exactly
      // once (emitCompletionEvent/routeEvent is idempotent via the wx flag).
      const next = {
        ...meta,
        ok: false,
        status: "orphaned",
        alive: false,
        taskContractStatus: "not-applicable",
        orphanedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        note: "Accepted run never reached launch (spawn failed before starting the child).",
      };
      delete next.taskContract;
      await writeMetadata(next);
      try { await emitCompletionEvent(next); } catch {}
      return next;
    }
    return { ...meta, alive: anyAlive };
  }
  if (!meta || meta.status !== "running") return meta;
  const now = Date.now();
  const cancelled = existsSync(cancelMarkerPath(meta.runId));
  const childPids = [meta.pid, meta.childPid, meta.runnerPid].filter(Boolean);
  const supervisorAlive = isPidAlive(meta.supervisorPid);
  const childAlive = childPids.some(isPidAlive);
  const alive = childAlive || supervisorAlive;
  // A detached supervisor can die during the launch handoff, before it records a
  // child PID. A durable cancellation marker is sufficient to settle that run:
  // there is then no process left that could observe the marker or finish it.
  if (cancelled && !supervisorAlive && !childPids.some(isPidAlive)) {
    const next = {
      ...meta,
      ok: false,
      status: "cancelled",
      exitCode: meta.exitCode ?? null,
      signal: meta.signal ?? null,
      // A cancelled run never produced a trusted completion, so any receipt the
      // child managed to emit before the kill (pending OR verified) must not be
      // retained as taskContractStatus; that would let a cancelled run be
      // reconstructed as a verified task success. Normalize to not-applicable.
      taskContractStatus: ["pending", "verified"].includes(meta.taskContractStatus) ? "not-applicable" : (meta.taskContractStatus ?? "not-applicable"),
      finishedAt: new Date().toISOString(),
      note: "Cancellation recovered after the background supervisor exited before recording a child process.",
    };
    delete next.taskContract;
    await writeMetadata(next);
    await rm(cancelMarkerPath(meta.runId), { force: true });
    try { await emitCompletionEvent(next); } catch {}
    return next;
  }
  let logAgeMs = null;
  try {
    const st = await stat(meta.logPath);
    logAgeMs = now - st.mtimeMs;
  } catch {}
  if ((!alive || (!childAlive && supervisorAlive && childPids.length > 0)) && (logAgeMs === null || logAgeMs >= staleMs)) {
    const next = {
      ...meta,
      ok: false,
      status: "orphaned",
      // An orphaned run is terminal: its supervisor and child are gone, so the
      // task contract will never be classified. Leaving "pending" here lies to
      // reconstructing consumers (group roll-ups, mcp retry classification, the
      // Pi extension) that the receipt is still being evaluated. Normalize to
      // "not-applicable" to match the cancel/deadline terminal convention, and
      // never report a stale "verified"/"done" claim for a run that died.
      taskContractStatus: ["pending", "verified"].includes(meta.taskContractStatus) ? "not-applicable" : (meta.taskContractStatus ?? "not-applicable"),
      orphanedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      note: `No live Terrarium child process found and log is stale${logAgeMs === null ? "" : ` (${Math.round(logAgeMs)}ms old)`}.`,
    };
    // Drop any lingering contract material (nonce/fingerprint) from the durable
    // terminal record; an orphaned run produced no trusted receipt to retain.
    delete next.taskContract;
    await writeMetadata(next);
    try { await emitCompletionEvent(next); } catch {}
    return next;
  }
  const idleMs = now - Date.parse(meta.lastActivityAt || meta.startedAt || new Date(now).toISOString());
  const needsAttention = alive && idleMs >= Number(meta.needsAttentionAfterMs || 60000);
  return { ...meta, alive, logAgeMs, idleMs, needsAttention };
}

export async function isRunAccessible({ requesterRunId, targetRunId, scope = "all" } = {}) {
  accessScope(scope, "all");
  if (!requesterRunId || scope === "all") return true;
  assertRunId(requesterRunId); assertRunId(targetRunId);
  if (requesterRunId === targetRunId) return true;
  if (scope === "self") return false;
  let current = targetRunId;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    let meta; try { meta = await readMetadata(current); } catch { return false; }
    if (meta.parentRunId === requesterRunId) return true;
    current = meta.parentRunId;
  }
  return false;
}

async function assertRunAccessible(args) {
  if (!(await isRunAccessible(args))) throw new Error(`run access denied by ${args.scope} scope`);
}

function effectiveAccess(requesterRunId, scope, envName) {
  const inheritedRequester = process.env.TERRARIUM_RUN_ID || null;
  if (inheritedRequester && requesterRunId && requesterRunId !== inheritedRequester) throw new Error("requester run id does not match inherited lineage");
  const requester = inheritedRequester || requesterRunId;
  const inheritedScope = process.env[envName];
  const requested = accessScope(scope, inheritedScope || (requester ? "self" : "all"));
  if (inheritedScope && ACCESS_SCOPES.indexOf(requested) > ACCESS_SCOPES.indexOf(accessScope(inheritedScope, "self"))) throw new Error(`cannot widen inherited ${envName === "TERRARIUM_READ_SCOPE" ? "read" : "status"} scope`);
  return { requesterRunId: requester, scope: inheritedScope ? accessScope(inheritedScope, "self") : requested };
}

export async function getRunStatus({ runId, staleMs = 30000, requesterRunId, scope } = {}) {
  if (!runId) throw new Error("runId required");
  const access = effectiveAccess(requesterRunId, scope, "TERRARIUM_STATUS_SCOPE");
  await assertRunAccessible({ ...access, targetRunId: runId });
  return await reconcileRun(await readMetadata(runId), { staleMs });
}

export async function ensureTerminalCallback({ runId, requesterRunId, scope } = {}) {
  // Recovery must degrade to a structured signal, not a raw filesystem/parse
  // throw. doctor's repairPlan points operators at this exact action for runs
  // whose terminal callback is missing; if the run log was pruned or corrupted
  // the caller needs an actionable reason, not an opaque ENOENT/SyntaxError.
  let result;
  try {
    result = await getRunStatus({ runId, requesterRunId, scope });
  } catch (error) {
    if (error?.code === "ENOENT") return { runId, terminal: false, routed: false, reason: "unknown-run", note: "no run log found for runId; nothing to recover (it may have been pruned)" };
    if (error instanceof SyntaxError) return { runId, terminal: false, routed: false, reason: "unreadable-metadata", note: "run metadata is corrupt and cannot be parsed; quarantine or repair the run log out-of-band" };
    throw error;
  }
  if (result.status === "running") return { runId, terminal: false, routed: false, reason: "active", note: "run is still active" };
  const routed = await emitCompletionEvent(result);
  return { runId, terminal: true, routed: !routed.duplicate, duplicate: routed.duplicate === true, eventId: routed.eventId, delivered: routed.delivered };
}

export async function cancelRun({ runId, requesterRunId, scope } = {}) {
  if (!runId) throw new Error("runId required");
  const access = effectiveAccess(requesterRunId, scope, "TERRARIUM_STATUS_SCOPE");
  await assertRunAccessible({ ...access, targetRunId: runId });
  const meta = await readMetadata(runId);
  if (meta.status !== "running") return { runId, status: meta.status, cancelled: false, note: "run is not active" };
  await writeFile(cancelMarkerPath(runId), `${new Date().toISOString()}\n`, { flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const childPids = [...new Set([meta.childPid, meta.pid].filter(Boolean))];
  if (!isPidAlive(meta.supervisorPid) && !childPids.some(isPidAlive)) {
    const settled = {
      ...meta,
      ok: false,
      status: "cancelled",
      exitCode: meta.exitCode ?? null,
      signal: meta.signal ?? null,
      // See reconcileRun: a cancelled run's pre-kill receipt (pending OR
      // verified) is not trusted completion evidence and must not survive as a
      // verified taskContractStatus on a cancelled record.
      taskContractStatus: ["pending", "verified"].includes(meta.taskContractStatus) ? "not-applicable" : (meta.taskContractStatus ?? "not-applicable"),
      finishedAt: new Date().toISOString(),
      note: "Cancellation recovered after the background supervisor exited before recording a child process.",
    };
    delete settled.taskContract;
    await writeMetadata(settled);
    await rm(cancelMarkerPath(runId), { force: true });
    try { await emitCompletionEvent(settled); } catch {}
    return { runId, status: settled.status, cancelled: true, requestedAt: settled.finishedAt };
  }
  // Never kill the supervisor directly: during the launch handoff it may be the
  // only process capable of observing the durable cancel marker and finalizing.
  for (const pid of childPids) signalProcessGroup(pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const pid of childPids) if (isPidAlive(pid)) signalProcessGroup(pid, "SIGKILL");
  return { runId, status: "cancel-requested", cancelled: true, requestedAt: new Date().toISOString() };
}

export async function materializePromptTransport(run, prompt) {
  if (Buffer.byteLength(prompt, "utf8") <= PROMPT_ARG_MAX_BYTES) return { promptTransport: "argv", promptArg: prompt, promptPath: null };
  await mkdir(LOG_DIR, { recursive: true });
  const promptPath = join(LOG_DIR, `${assertRunId(run.runId)}.prompt`);
  await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { promptTransport: "file", promptArg: "Read the complete task from TERRARIUM_PROMPT_FILE.", promptPath };
}

function childEnvironment(run, transport = null) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "CMUX_PI_HOOKS_DISABLED") continue;
    if (key.startsWith("CMUX_")) delete env[key];
  }
  return {
    ...env,
    CMUX_PI_HOOKS_DISABLED: "1",
    TERRARIUM_RUN_ID: run.runId,
    TERRARIUM_PARENT_RUN_ID: run.parentRunId ?? "",
    TERRARIUM_DEPTH: String(run.depth),
    TERRARIUM_MAX_DEPTH: String(run.maxDepth),
    TERRARIUM_CHILD_BUDGET: String(process.env.TERRARIUM_CHILD_BUDGET ?? 1),
    TERRARIUM_ALLOW_SPAWN: String(run.allowSpawn),
    TERRARIUM_STATUS_SCOPE: run.statusScope,
    TERRARIUM_READ_SCOPE: run.readScope,
    TERRARIUM_MRE_LOG_PATH: run.mreLogPath,
    ...(transport?.promptPath ? { TERRARIUM_PROMPT_TRANSPORT: transport.promptTransport, TERRARIUM_PROMPT_FILE: transport.promptPath } : {}),
  };
}

export async function superviseTerrariumBackground({ run, parts, prompt, base, workspace, specPath } = {}) {
  const transport = await materializePromptTransport(run, prompt);
  const env = childEnvironment(run, transport);
  if (existsSync(cancelMarkerPath(run.runId))) {
    const step = transition(initialRunState({ requireReceipt: run.requireTaskContract }), { type: "CancelRequested" });
    const terminal = step.decisions.find((decision) => decision.type === "Finalize");
    const ws = await finalizeWorkspace(workspace, base);
    const { type: _type, reason: _reason, ...result } = terminal;
    const finalResult = await persistFinishedRun(base, { background: true, supervisorPid: process.pid, ...result, ...ws });
    if (specPath) await rm(specPath, { force: true });
    await rm(cancelMarkerPath(run.runId), { force: true });
    try { await emitCompletionEvent(finalResult); } catch {}
    return finalResult;
  }
  const child = spawn(parts[0], [...parts.slice(1), transport.promptArg], { stdio: ["ignore", "pipe", "pipe"], env, cwd: run.cwd, detached: true });
  const started = { ok: true, ...base, status: "running", background: true, pid: child.pid, childPid: child.pid, supervisorPid: process.pid, lastSeenAt: new Date().toISOString() };
  await writeMetadata(started);

  return await new Promise((resolveRun) => {
    let machine = initialRunState({ requireReceipt: run.requireTaskContract });
    let stdout = "";
    let stderr = "";
    let lastProgressAt = 0;
    let progressBuffer = "";
    let finishing = false;
    void emitProgressEvent(run, 'started');
    const heartbeat = setInterval(() => { void emitProgressEvent(run, 'running', { activity: false }); }, 3000);
    let cancelObserved = false;
    const cancelWatcher = setInterval(() => {
      if (!cancelObserved && existsSync(cancelMarkerPath(run.runId))) {
        cancelObserved = true;
        void observe({ type: "CancelRequested" });
      }
    }, 50);
    const progress = async (s) => {
      progressBuffer += s;
      const now = Date.now();
      if (now - lastProgressAt < 5000) return;
      lastProgressAt = now;
      const lines = progressBuffer.trim().split(/\r?\n/).filter(Boolean);
      progressBuffer = "";
      if (lines.length) await emitProgressEvent(run, lines.slice(-3).join("\n"));
    };
    let finalResult = null;
    let childOutputSeen = false;
    // Liveness-aware startup watchdog. The original hard deadline killed on "no
    // stdout within N ms" even when the child was alive and productive. pi -p
    // buffers its first stdout until the task completes and, under concurrent cold
    // starts (extension discovery + provider resolution), that first byte can lag
    // far past the window while the worker is healthy and writing workspace files.
    // Those children were false-killed while terrarium_status still reported
    // alive:true. Fix: a LIVE child is never killed by the base window; it only
    // dies at an absolute hard ceiling (default 6x, so a genuinely wedged-but-alive
    // child still dies). The base window only kills a child that produced no stdout
    // AND is no longer alive (crashed/exec-failed before any output) — the fast,
    // real failure the watchdog was meant to catch. Log growth (run or mre log) is
    // an additional positive liveness signal that resets the observation.
    const startupWindowMs = run.startupWatchdogMs;
    const startupHardCeilingMs = startupWindowMs > 0
      ? Math.min(3600000, Number(process.env.TERRARIUM_STARTUP_HARD_CEILING_MS) || startupWindowMs * 6)
      : 0;
    const startupBeganAt = Date.now();
    let lastLogSize = -1;
    const logGrewSince = () => {
      let grew = false;
      for (const p of [run.logPath, run.mreLogPath]) {
        try { const sz = statSync(p).size; if (sz > lastLogSize) { lastLogSize = sz; grew = true; } } catch { /* not yet created */ }
      }
      return grew;
    };
    const startupWatchdog = startupWindowMs > 0 ? setInterval(() => {
      if (childOutputSeen || finishing) { clearInterval(startupWatchdog); return; }
      const now = Date.now();
      const elapsed = now - startupBeganAt;
      const alive = isPidAlive(child.pid);
      const grew = logGrewSince();
      // Alive (optionally also logging) and under the hard ceiling: keep waiting.
      // Do not kill a productive child just because stdout has not flushed yet.
      if ((alive || grew) && elapsed < startupHardCeilingMs) return;
      // Kill only when: past the base window with a DEAD, silent child (fast fail),
      // or the absolute hard ceiling is exceeded (wedged-but-alive).
      const hitCeiling = elapsed >= startupHardCeilingMs;
      const deadAndSilent = !alive && !grew && elapsed >= startupWindowMs;
      if (hitCeiling || deadAndSilent) {
        clearInterval(startupWatchdog);
        const why = hitCeiling
          ? `startup-timeout: child produced no stdout and hit the ${startupHardCeilingMs}ms hard ceiling`
          : `startup-timeout: child exited before producing output within ${startupWindowMs}ms`;
        signalProcessGroup(child.pid, "SIGTERM");
        void log(run.logPath, `\n${why}\n`);
        void observe({ type: "RuntimeError", exitCode: 124, error: why });
      }
    }, Math.max(1000, Math.min(startupWindowMs, 5000))) : null;
    const execute = async (decisions) => {
      for (const decision of decisions) {
        if (decision.type === "TerminateChild") signalProcessGroup(child.pid, "SIGTERM");
        if (decision.type === "Finalize" && !finishing) {
          finishing = true;
          if (timer) clearTimeout(timer);
          if (startupWatchdog) clearInterval(startupWatchdog);
          clearInterval(heartbeat);
          clearInterval(cancelWatcher);
          const ws = await finalizeWorkspace(workspace, base);
          const { type: _type, reason: _reason, ...terminal } = decision;
          finalResult = await persistFinishedRun(base, { background: true, pid: child.pid, childPid: child.pid, supervisorPid: process.pid, stdoutTail: tail(stdout), stderrTail: tail(stderr), ...terminal, ...ws });
          if (specPath) await rm(specPath, { force: true });
          // Journal the durable terminal event at Finalize, not gated behind a later
          // QueueCallback. Finalize always runs; QueueCallback may be skipped if the
          // supervisor is detached/killed first — which left terminal runs missing
          // durable callback events (doctor: missingTerminalCallbacks). routeEvent is
          // idempotent (wx flag), so a later QueueCallback emit is a harmless no-op.
          try { await emitCompletionEvent(finalResult); } catch {}
        }
        if (decision.type === "QueueCallback" && finalResult) {
          await emitCompletionEvent(finalResult);
          resolveRun(finalResult);
        }
      }
    };
    const observe = async (input) => {
      const step = transition(machine, input);
      machine = step.state;
      await execute(step.decisions);
    };
    const timer = run.timeoutMs > 0 ? setTimeout(() => { void observe({ type: "DeadlineReached" }); }, run.timeoutMs) : null;
    child.stdout.on("data", async (d) => { childOutputSeen = true; if (startupWatchdog) clearInterval(startupWatchdog); const s = String(d); stdout += s; await log(run.logPath, s); await progress(s); });
    child.stderr.on("data", async (d) => { childOutputSeen = true; if (startupWatchdog) clearInterval(startupWatchdog); const s = String(d); stderr += s; await log(run.logPath, s); await progress(s); });
    child.on("error", async (e) => {
      await log(run.logPath, `\nerror: ${e.message}\n`);
      const receipt = validateTaskContractOutput(stdout, base.taskContract);
      if (run.requireTaskContract) await observe({ type: "ReceiptObserved", ...receipt });
      await observe({ type: "RuntimeError", exitCode: 127, error: e.message });
    });
    child.on("close", async (code, signal) => {
      const exitCode = code ?? (signal ? 128 : 0);
      const cancelled = existsSync(cancelMarkerPath(run.runId));
      if (cancelled) await observe({ type: "CancelRequested" });
      await log(run.logPath, `\nexit: ${exitCode}${signal ? ` signal: ${signal}` : ""}${cancelled ? " cancelled" : ""}\n`);
      await observe({ type: "ChildExited", exitCode, signal });
      if (run.requireTaskContract) await observe({ type: "ReceiptObserved", ...validateTaskContractOutput(stdout, base.taskContract) });
      if (cancelled) await rm(cancelMarkerPath(run.runId), { force: true });
    });
  });
}

export async function spawnTerrariumBackground(opts = {}) {
  const { run, parts, prompt, base, workspace } = await prepareRun({ ...opts, stream: false });
  const invocation = `${parts.join(" ")} ${JSON.stringify(prompt)}\n`;
  if (run.dryRun) {
    await log(run.logPath, invocation);
    const ws = await finalizeWorkspace(workspace, base);
    return finishRun(base, { ok: true, dryRun: true, status: "done", invocation, exitCode: 0, stdoutTail: invocation, stderrTail: "", ...ws });
  }

  const specPath = join(LOG_DIR, `${run.runId}.background.json`);
  await writeFile(specPath, JSON.stringify({ run, parts, prompt, base, workspace, specPath }, null, 2) + "\n", { flag: "wx" });
  // Pin TERRARIUM_HOME for the detached supervisor so it always resolves the same
  // home as this parent, regardless of how the parent resolved it (env vs config).
  // Without this, a test/context that set the home by a non-env mechanism would
  // let the detached process fall back to ~/.terrarium.
  const supervisor = spawn(process.execPath, [fileURLToPath(new URL("./supervisor.js", import.meta.url)), specPath], { stdio: "ignore", detached: true, env: { ...process.env, TERRARIUM_HOME: HOME } });
  supervisor.unref();
  const started = { ok: true, ...base, status: "running", background: true, supervisorPid: supervisor.pid, lastSeenAt: new Date().toISOString() };
  await writeMetadata(started);
  return started;
}

export async function runTerrarium(opts = {}) {
  const { run, parts, prompt, base, workspace } = await prepareRun(opts);
  if (run.dryRun) {
    const invocation = `${parts.join(" ")} ${JSON.stringify(prompt)}\n`;
    if (run.stream) process.stdout.write(invocation);
    await log(run.logPath, invocation);
    const ws = await finalizeWorkspace(workspace, base);
    return finishRun(base, { ok: true, dryRun: true, status: "done", invocation, exitCode: 0, stdoutTail: invocation, stderrTail: "", ...ws });
  }

  const transport = await materializePromptTransport(run, prompt);
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const env = childEnvironment(run, transport);
    const child = spawn(parts[0], [...parts.slice(1), transport.promptArg], { stdio: ["inherit", "pipe", "pipe"], env, cwd: run.cwd, detached: true });
    void writeMetadata({ ...base, status: "running", pid: child.pid, childPid: child.pid, lastSeenAt: new Date().toISOString() });
    const timer = run.timeoutMs > 0 ? setTimeout(() => signalProcessGroup(child.pid, "SIGTERM"), run.timeoutMs) : null;

    child.stdout.on("data", async (d) => { const s = String(d); stdout += s; if (run.stream) process.stdout.write(d); await log(run.logPath, s); });
    child.stderr.on("data", async (d) => { const s = String(d); stderr += s; if (run.stream) process.stderr.write(d); await log(run.logPath, s); });
    child.on("error", async (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      await log(run.logPath, `\nerror: ${e.message}\n`);
      const ws = await finalizeWorkspace(workspace, base);
      resolve(await finishRun(base, { ok: false, status: "error", exitCode: 127, error: e.message, stdoutTail: tail(stdout), stderrTail: tail(stderr), contractOutput: stdout, ...ws }));
    });
    child.on("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 : 0);
      const cancelled = existsSync(cancelMarkerPath(run.runId));
      await log(run.logPath, `\nexit: ${exitCode}${signal ? ` signal: ${signal}` : ""}${cancelled ? " cancelled" : ""}\n`);
      const ws = await finalizeWorkspace(workspace, base);
      resolve(await finishRun(base, { ok: cancelled ? false : exitCode === 0, status: cancelled ? "cancelled" : exitCode === 0 ? "done" : "failed", exitCode, signal, stdoutTail: tail(stdout), stderrTail: tail(stderr), contractOutput: stdout, ...ws }));
      if (cancelled) await rm(cancelMarkerPath(run.runId), { force: true });
    });
  });
}

export async function listRuns({ limit = 20, requesterRunId, scope, channel, workflowId, sinceMs } = {}) {
  const access = effectiveAccess(requesterRunId, scope, "TERRARIUM_STATUS_SCOPE");
  await mkdir(LOG_DIR, { recursive: true });
  const wantLimit = Math.max(0, Number(limit) || 20);
  // Bounded scan: run metadata filenames embed a sortable timestamp, so newest
  // files sort last. Reading the ENTIRE runs dir made list-mode status scale with
  // home size (O(all runs) work to return `limit`), which under a bloated home
  // pushed terrarium_status past the MCP deadline — exactly the recovery call a
  // caller makes after a spawn RPC timed out. We now read at most a bounded window
  // of the most-recent files. activeCount/activeRunIds are honest WITHIN that
  // window (documented as `activeScanWindow`); a running run older than the window
  // is not counted, which is acceptable for a status list and keeps the call O(1)
  // in home size. Callers needing a specific run use status-by-id (single read).
  // Env override is authoritative when set (>=1); otherwise a sane default floor
  // that never scans fewer than the page or 200 recent files.
  const envWindow = Number(process.env.TERRARIUM_LIST_SCAN_WINDOW);
  const activeScanWindow = Number.isInteger(envWindow) && envWindow >= 1
    ? Math.max(envWindow, wantLimit)
    : Math.max(200, wantLimit * 4);
  // Background supervisor specs also end in .json but are not run metadata.
  // Read only canonical run files and ignore malformed/non-run records.
  const files = (await readdir(LOG_DIR))
    .filter((f) => f.endsWith(".json") && !f.endsWith(".background.json"))
    .sort().reverse()
    .slice(0, activeScanWindow);
  const allRuns = [];
  for (const file of files) {
    try {
      const run = await reconcileRun(JSON.parse(await readFile(join(LOG_DIR, file), "utf8")));
      if (run?.runId && run?.status) allRuns.push(run);
    } catch {}
  }
  const visibleRuns = [];
  for (const run of allRuns) if (await isRunAccessible({ ...access, targetRunId: run.runId })) visibleRuns.push(run);
  // Recovery affordance: a caller whose spawn RPC timed out lost its runId but
  // still knows the channel/workflow it launched on. Filtering by channel +
  // workflowId + a recent time window lets it re-associate the started run(s)
  // instead of relaunching (which would duplicate the child). Filters are
  // applied AFTER access-scoping so they never widen visibility.
  const matchChannel = channel != null ? String(channel) : null;
  const matchWorkflow = workflowId != null ? String(workflowId) : null;
  const sinceTs = Number.isFinite(Number(sinceMs)) && Number(sinceMs) > 0 ? Date.now() - Number(sinceMs) : null;
  const filtered = visibleRuns.filter((run) => {
    if (matchChannel != null && run.channel !== matchChannel) return false;
    if (matchWorkflow != null && run.workflowId !== matchWorkflow) return false;
    if (sinceTs != null) { const t = Date.parse(run.startedAt ?? ""); if (!Number.isFinite(t) || t < sinceTs) return false; }
    return true;
  });
  const active = filtered.filter((run) => run.status === "running" && run.alive !== false);
  const scanTruncated = files.length >= activeScanWindow;
  return {
    version: VERSION,
    logDir: LOG_DIR,
    activeCount: active.length,
    activeRunIds: active.map((run) => run.runId),
    activeScanWindow,
    scanTruncated,
    ...(matchChannel != null || matchWorkflow != null || sinceTs != null ? { filtered: { channel: matchChannel, workflowId: matchWorkflow, sinceMs: sinceTs != null ? Number(sinceMs) : null } } : {}),
    count: Math.min(filtered.length, wantLimit),
    runs: filtered.slice(0, wantLimit),
  };
}

async function recordedLogPath({ runId, logPath, kind }) {
  if (kind !== "terrarium" && kind !== "mre") throw new Error(`unknown log kind: ${kind}`);
  if (runId) {
    const meta = await readMetadata(runId);
    const expected = kind === "terrarium" ? meta.logPath ?? join(LOG_DIR, `${runId}.log`) : meta.mreLogPath ?? join(LOG_DIR, `${runId}.mre.log`);
    if (!meta.logPathExternal && !meta.mreLogPathExternal) confinedLogPath(expected, "recorded log path");
    if (logPath && resolve(logPath) !== resolve(expected)) throw new Error("logPath does not match the recorded log for this run");
    return expected;
  }
  if (!logPath) throw new Error("runId or recorded logPath required");
  await mkdir(LOG_DIR, { recursive: true });
  const requested = resolve(logPath);
  const files = (await readdir(LOG_DIR)).filter((file) => file.endsWith(".json") && !file.endsWith(".background.json"));
  for (const file of files) {
    let meta; try { meta = JSON.parse(await readFile(join(LOG_DIR, file), "utf8")); } catch { continue; }
    const expected = kind === "terrarium" ? meta.logPath : meta.mreLogPath;
    if (expected && resolve(expected) === requested) {
      if (!meta.logPathExternal && !meta.mreLogPathExternal) confinedLogPath(expected, "recorded log path");
      return expected;
    }
  }
  throw new Error("logPath is not a recorded Terrarium log");
}

export async function readRun({ runId, logPath, kind = "terrarium", tailBytes = 20000, requesterRunId, scope } = {}) {
  const access = effectiveAccess(requesterRunId, scope, "TERRARIUM_READ_SCOPE");
  if (access.requesterRunId && access.scope !== "all" && !runId) throw new Error("scoped log reads require a runId");
  if (runId) await assertRunAccessible({ ...access, targetRunId: runId });
  const readablePath = await recordedLogPath({ runId, logPath, kind });
  const text = await readFile(readablePath, "utf8");
  return { kind, logPath: readablePath, text: tail(text, tailBytes) };
}
