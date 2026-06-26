import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishEvent, eventForRun, TerrariumEventType } from "./event-runtime.js";
import { routeEvent } from "./router.js";
import { initialRunState, transition } from "./run-machine.js";

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
export function applyModelToAgent(agent, model, { strict = true } = {}) {
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
  const contract = taskContract ? `\nYour final output MUST include exactly one line:\nTERRARIUM_RESULT=${JSON.stringify({ runId: taskContract.runId, taskFingerprint: taskContract.taskFingerprint, nonce: taskContract.nonce, summary: "brief task-specific result" })}` : "";
  if (resolved === "minimal") {
    return `Terrarium child. Single bounded task. Do not spawn subagents.\n${allowSpawn ? "One explicit Terrarium child call is available only if the task requires it." : "Terrarium recursion is disabled; do not call Terrarium tools."}

Do the assigned task directly. Do not inspect unrelated Terrarium runs, callbacks, logs, or other agents.
Reply with: Summary, Changed files, Verification.${contract}

Task:
${task}`;
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
${task}`;
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
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => stdout += String(d));
    child.stderr?.on("data", (d) => stderr += String(d));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + e.message }));
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 0), signal, stdout, stderr }));
  });
}

function tail(text, max = 12000) {
  return text.length > max ? text.slice(-max) : text;
}

async function gitOutput(cwd, args) {
  const r = await spawnCapture("git", args, { cwd });
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
  const appliedAgent = applyModelToAgent(baseAgent, requestedModel, { strict: Boolean(opts.model) });
  const model = appliedAgent === baseAgent ? modelFlagInAgent(appliedAgent) : requestedModel;
  let agent = appliedAgent;
  const agentParts = splitCommand(agent);
  if (basename(agentParts[0] || "") === "pi" && !agentParts.includes("--no-session") && !agentParts.includes("--session") && !agentParts.includes("--session-id") && opts.ephemeral !== false) {
    agent = [...agentParts, "--no-session"].map(shellToken).join(" ");
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
  const needsAttentionAfterMs = Number(opts.needsAttentionAfterMs ?? config.needsAttentionAfterMs ?? 60000);
  if (!Number.isFinite(needsAttentionAfterMs) || needsAttentionAfterMs < 5000 || needsAttentionAfterMs > 3600000) throw new Error("needsAttentionAfterMs must be between 5000 and 3600000");
  const callerChannel = basename(process.cwd()).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "default";
  const channel = correlationValue(opts.channel ?? process.env.TERRARIUM_EVENT_CHANNEL ?? callerChannel, "channel");
  const workflowId = correlationValue(opts.workflowId ?? parentRunId ?? runId, "workflow id");
  const sessionId = correlationValue(opts.sessionId ?? process.env.TERRARIUM_SESSION_ID ?? null, "session id");
  return { runId, parentRunId, depth, maxDepth, agent, model, profile, readOnly, timeoutMs, task, dryRun, cwd, originalCwd: cwd, stream, logPath, mreLogPath, isolation, keepWorkspace, callerSpawnAllowed, allowSpawn, statusScope, readScope, requireTaskContract, taskContract, needsAttentionAfterMs, channel, workflowId, sessionId };
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

async function prepareRun(opts = {}) {
  const config = opts.config ?? await loadConfig();
  const run = buildRun(opts, config);
  // All non-mutating validation must happen before a child slot is claimed.
  if (!run.task) throw new Error("missing task");
  if (run.depth > run.maxDepth) throw new Error(`Terrarium max depth exceeded (${run.depth}/${run.maxDepth})`);
  if (run.parentRunId && !run.callerSpawnAllowed) throw new Error("Terrarium spawn capability denied for this child");
  const parts = splitCommand(run.agent);
  if (parts.length === 0) throw new Error("empty agent command");
  const workspace = await prepareWorkspace(run);
  const prompt = childPrompt(run.task, run);
  run.logPath ??= await defaultLogPath(run.runId);
  run.mreLogPath ??= await defaultMreLogPath(run.runId);
  const startedAt = new Date().toISOString();
  const base = { runId: run.runId, parentRunId: run.parentRunId, depth: run.depth, maxDepth: run.maxDepth, version: VERSION, agent: run.agent, model: run.model, profile: run.profile, readOnly: run.readOnly, task: run.task, cwd: run.cwd, originalCwd: run.originalCwd, isolation: run.isolation, workspace, logPath: run.logPath, mreLogPath: run.mreLogPath, startedAt, lastActivityAt: startedAt, progressText: "started", needsAttentionAfterMs: run.needsAttentionAfterMs, status: "running", git: await gitInfo(run.cwd), allowSpawn: run.allowSpawn, statusScope: run.statusScope, readScope: run.readScope, channel: run.channel, workflowId: run.workflowId, sessionId: run.sessionId, taskFingerprint: run.taskContract?.taskFingerprint ?? taskFingerprint(run.task), taskContractStatus: run.requireTaskContract ? "pending" : "not-required", taskContract: run.taskContract };
  let claimPath = null;
  try {
    claimPath = await claimChildSlot(run);
    await writeMetadata(base);
    const header = `terrarium ${VERSION}\nrun: ${run.runId}\nparent: ${run.parentRunId ?? "none"}\ndepth: ${run.depth}/${run.maxDepth}\nagent: ${run.agent}${run.readOnly ? " (read-only preset)" : ""}\nmodel: ${run.model ?? "runner default"}\nprofile: ${run.profile}\ntask: ${run.task}\ncwd: ${run.cwd}\noriginal cwd: ${run.originalCwd}\nisolation: ${run.isolation}${workspace ? ` (${workspace.path})` : ""}\nlog: ${run.logPath}\nmre log: ${run.mreLogPath}\n\n`;
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
    const contract = validateTaskContractOutput(result.stdoutTail, base.taskContract);
    result.taskContractStatus = contract.status;
    if (contract.summary) result.taskResultSummary = contract.summary;
    if (contract.status !== "verified") result = { ...result, ok: false, status: result.exitCode === 0 ? "inconclusive" : result.status, note: `Task contract ${contract.status}; process exit is not accepted as task success.` };
  }
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
  if (!meta || meta.status !== "running") return meta;
  const now = Date.now();
  const cancelled = existsSync(cancelMarkerPath(meta.runId));
  const childPids = [meta.pid, meta.childPid, meta.runnerPid].filter(Boolean);
  const supervisorAlive = isPidAlive(meta.supervisorPid);
  const alive = [...childPids, meta.supervisorPid].filter(Boolean).some(isPidAlive);
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
      taskContractStatus: meta.taskContractStatus === "pending" ? "not-applicable" : meta.taskContractStatus,
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
  if (!alive && (logAgeMs === null || logAgeMs >= staleMs)) {
    const next = {
      ...meta,
      ok: false,
      status: "orphaned",
      orphanedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      note: `No live Terrarium child process found and log is stale${logAgeMs === null ? "" : ` (${Math.round(logAgeMs)}ms old)`}.`,
    };
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
  const result = await getRunStatus({ runId, requesterRunId, scope });
  if (result.status === "running") return { runId, terminal: false, routed: false, note: "run is still active" };
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
      taskContractStatus: meta.taskContractStatus === "pending" ? "not-applicable" : meta.taskContractStatus,
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

function childEnvironment(run) {
  return {
    ...process.env,
    TERRARIUM_RUN_ID: run.runId,
    TERRARIUM_PARENT_RUN_ID: run.parentRunId ?? "",
    TERRARIUM_DEPTH: String(run.depth),
    TERRARIUM_MAX_DEPTH: String(run.maxDepth),
    TERRARIUM_CHILD_BUDGET: String(process.env.TERRARIUM_CHILD_BUDGET ?? 1),
    TERRARIUM_ALLOW_SPAWN: String(run.allowSpawn),
    TERRARIUM_STATUS_SCOPE: run.statusScope,
    TERRARIUM_READ_SCOPE: run.readScope,
    TERRARIUM_MRE_LOG_PATH: run.mreLogPath,
  };
}

export async function superviseTerrariumBackground({ run, parts, prompt, base, workspace, specPath } = {}) {
  const env = childEnvironment(run);
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
  const child = spawn(parts[0], [...parts.slice(1), prompt], { stdio: ["ignore", "pipe", "pipe"], env, cwd: run.cwd, detached: true });
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
    const execute = async (decisions) => {
      for (const decision of decisions) {
        if (decision.type === "TerminateChild") signalProcessGroup(child.pid, "SIGTERM");
        if (decision.type === "Finalize" && !finishing) {
          finishing = true;
          if (timer) clearTimeout(timer);
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
    child.stdout.on("data", async (d) => { const s = String(d); stdout += s; await log(run.logPath, s); await progress(s); });
    child.stderr.on("data", async (d) => { const s = String(d); stderr += s; await log(run.logPath, s); await progress(s); });
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
  const supervisor = spawn(process.execPath, [fileURLToPath(new URL("./supervisor.js", import.meta.url)), specPath], { stdio: "ignore", detached: true });
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

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const env = childEnvironment(run);
    const child = spawn(parts[0], [...parts.slice(1), prompt], { stdio: ["inherit", "pipe", "pipe"], env, cwd: run.cwd, detached: true });
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
      resolve(await finishRun(base, { ok: false, status: "error", exitCode: 127, error: e.message, stdoutTail: tail(stdout), stderrTail: tail(stderr), ...ws }));
    });
    child.on("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 : 0);
      const cancelled = existsSync(cancelMarkerPath(run.runId));
      await log(run.logPath, `\nexit: ${exitCode}${signal ? ` signal: ${signal}` : ""}${cancelled ? " cancelled" : ""}\n`);
      const ws = await finalizeWorkspace(workspace, base);
      resolve(await finishRun(base, { ok: cancelled ? false : exitCode === 0, status: cancelled ? "cancelled" : exitCode === 0 ? "done" : "failed", exitCode, signal, stdoutTail: tail(stdout), stderrTail: tail(stderr), ...ws }));
      if (cancelled) await rm(cancelMarkerPath(run.runId), { force: true });
    });
  });
}

export async function listRuns({ limit = 20, requesterRunId, scope } = {}) {
  const access = effectiveAccess(requesterRunId, scope, "TERRARIUM_STATUS_SCOPE");
  await mkdir(LOG_DIR, { recursive: true });
  // Background supervisor specs also end in .json but are not run metadata.
  // Read only canonical run files and ignore malformed/non-run records.
  const files = (await readdir(LOG_DIR))
    .filter((f) => f.endsWith(".json") && !f.endsWith(".background.json"))
    .sort().reverse();
  const allRuns = [];
  for (const file of files) {
    try {
      const run = await reconcileRun(JSON.parse(await readFile(join(LOG_DIR, file), "utf8")));
      if (run?.runId && run?.status) allRuns.push(run);
    } catch {}
  }
  const visibleRuns = [];
  for (const run of allRuns) if (await isRunAccessible({ ...access, targetRunId: run.runId })) visibleRuns.push(run);
  const active = visibleRuns.filter((run) => run.status === "running" && run.alive !== false);
  return {
    version: VERSION,
    logDir: LOG_DIR,
    activeCount: active.length,
    activeRunIds: active.map((run) => run.runId),
    count: Math.min(visibleRuns.length, Math.max(0, Number(limit) || 20)),
    runs: visibleRuns.slice(0, Math.max(0, Number(limit) || 20)),
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
