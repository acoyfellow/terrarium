import { spawn } from "node:child_process";
import { appendFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishEvent, eventForRun, TerrariumEventType } from "./event-runtime.js";

export const VERSION = "0.0.1";
export const HOME = join(homedir(), ".terrarium");
export const LOG_DIR = join(HOME, "runs");
export const CONFIG_PATH = join(HOME, "config.json");
export const WORKSPACE_DIR = join(HOME, "workspaces");
export const EVENT_DIR = join(HOME, "events");

export function splitCommand(command) {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "")) ?? [];
}

export function makeRunId() {
  return `ter_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${Math.random().toString(36).slice(2, 8)}`;
}

export const PROMPT_PROFILES = ["default", "minimal"];
export const DEFAULT_PROMPT_PROFILE = "default";

export const READ_ONLY_AGENT = "opencode run --agent explore";

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
  const { depth, maxDepth, runId, parentRunId, profile } = opts;
  const resolved = resolvePromptProfile(profile);
  if (resolved === "minimal") {
    return `Terrarium child. Single bounded task. Do not spawn subagents.

Reply with: Summary, Changed files, Verification.

Task:
${task}`;
  }
  return `You are a Terrarium child agent.

Rules:
- Complete exactly the delegated task.
- You may call Terrarium at most once.
- Do not fan out.
- Current Terrarium depth: ${depth ?? 1}/${maxDepth ?? 3}.
- Run ID: ${runId ?? "unknown"}.
- Parent run ID: ${parentRunId ?? "none"}.

Return in this shape:
Summary:
Changed files:
Verification:
Follow-ups:

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
  await writeFile(metadataPath(meta.runId), JSON.stringify(meta, null, 2) + "\n");
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
  const agent = applyModelToAgent(baseAgent, requestedModel, { strict: Boolean(opts.model) });
  const model = agent === baseAgent ? modelFlagInAgent(agent) : requestedModel;
  const readOnly = requestedReadOnly && !opts.agent;
  const profile = resolvePromptProfile(opts.profile ?? config.profile);
  const timeoutMs = Number(opts.timeoutMs ?? config.timeoutMs ?? 0);
  const { task, dryRun = false, cwd = process.cwd(), stream = true } = opts;
  const isolation = opts.isolation || config.isolation || "none";
  const keepWorkspace = Boolean(opts.keepWorkspace ?? config.keepWorkspace ?? false);
  const logPath = opts.logPath ? confinedLogPath(opts.logPath) : opts.logPath;
  const mreLogPath = opts.mreLogPath ? confinedLogPath(opts.mreLogPath, "MRE log path") : opts.mreLogPath;
  return { runId, parentRunId, depth, maxDepth, agent, model, profile, readOnly, timeoutMs, task, dryRun, cwd, originalCwd: cwd, stream, logPath, mreLogPath, isolation, keepWorkspace };
}

async function workspaceExcludes() {
  return new Set([".git", "node_modules", ".next", "dist", "build", "target", "coverage", ".terrarium-workspace"]);
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
    await writeFile(join(workspacePath, ".terrarium-workspace"), JSON.stringify({ runId: run.runId, source: run.originalCwd, isolation: "copy" }, null, 2) + "\n");
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
    await writeFile(join(workspacePath, ".terrarium-workspace"), JSON.stringify({ runId: run.runId, source: root, isolation: "worktree", branch }, null, 2) + "\n");
    run.cwd = workspacePath;
    return { type: "worktree", path: workspacePath, source: root, branch, cleanup: !run.keepWorkspace };
  }
  throw new Error(`unknown isolation mode: ${run.isolation}`);
}

export async function capturePatch(workspacePath) {
  await spawnCapture("git", ["add", "-A", "--", ":!.terrarium-workspace"], { cwd: workspacePath });
  return await spawnCapture("git", ["diff", "--cached", "--binary"], { cwd: workspacePath });
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
  if (!run.parentRunId) return;
  const budget = Number(process.env.TERRARIUM_CHILD_BUDGET ?? 1);
  if (!Number.isInteger(budget) || budget < 0 || budget > 100) throw new Error("invalid Terrarium child budget");
  const claimsDir = join(LOG_DIR, `${run.parentRunId}.children`);
  await mkdir(claimsDir, { recursive: true });
  for (let slot = 1; slot <= budget; slot++) {
    try { await writeFile(join(claimsDir, String(slot)), run.runId, { flag: "wx" }); return; } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  throw new Error(`Terrarium child budget exceeded (${budget})`);
}

async function prepareRun(opts = {}) {
  const config = opts.config ?? await loadConfig();
  const run = buildRun(opts, config);
  await claimChildSlot(run);
  if (!run.task) throw new Error("missing task");
  if (run.depth > run.maxDepth) throw new Error(`Terrarium max depth exceeded (${run.depth}/${run.maxDepth})`);
  const parts = splitCommand(run.agent);
  if (parts.length === 0) throw new Error("empty agent command");
  const workspace = await prepareWorkspace(run);
  const prompt = childPrompt(run.task, run);
  run.logPath ??= await defaultLogPath(run.runId);
  run.mreLogPath ??= await defaultMreLogPath(run.runId);
  const startedAt = new Date().toISOString();
  const base = { runId: run.runId, parentRunId: run.parentRunId, depth: run.depth, maxDepth: run.maxDepth, version: VERSION, agent: run.agent, model: run.model, profile: run.profile, readOnly: run.readOnly, task: run.task, cwd: run.cwd, originalCwd: run.originalCwd, isolation: run.isolation, workspace, logPath: run.logPath, mreLogPath: run.mreLogPath, startedAt, status: "running", git: await gitInfo(run.cwd) };
  await writeMetadata(base);
  const header = `terrarium ${VERSION}\nrun: ${run.runId}\nparent: ${run.parentRunId ?? "none"}\ndepth: ${run.depth}/${run.maxDepth}\nagent: ${run.agent}${run.readOnly ? " (read-only preset)" : ""}\nmodel: ${run.model ?? "runner default"}\nprofile: ${run.profile}\ntask: ${run.task}\ncwd: ${run.cwd}\noriginal cwd: ${run.originalCwd}\nisolation: ${run.isolation}${workspace ? ` (${workspace.path})` : ""}\nlog: ${run.logPath}\nmre log: ${run.mreLogPath}\n\n`;
  if (run.stream) process.stdout.write(header);
  await writeFile(run.logPath, header);
  await writeFile(run.mreLogPath, "", { flag: "wx" });
  return { run, parts, prompt, base, workspace };
}

async function emitProgressEvent(run, text) {
  try {
    const channel = run.channel ?? process.env.TERRARIUM_EVENT_CHANNEL;
    const event = { type: "terrarium.progress", runId: run.runId, cwd: run.originalCwd ?? run.cwd, task: run.task, text, at: new Date().toISOString(), channel: channel ?? null };
    await publishEvent(eventForRun(TerrariumEventType.Progress, run, { text }));
    if (!channel) return;
    const dir = join(EVENT_DIR, channel);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${run.runId}.progress.json`), `${JSON.stringify(event)}\n`);
  } catch {}
}

async function emitCompletionEvent(result) {
  try {
    const channel = result.channel ?? process.env.TERRARIUM_EVENT_CHANNEL;
    const event = {
      type: "terrarium.completed",
      runId: result.runId,
      status: result.status,
      ok: result.ok,
      exitCode: result.exitCode,
      signal: result.signal ?? null,
      cwd: result.originalCwd ?? result.cwd,
      task: result.task,
      finishedAt: result.finishedAt,
      logPath: result.logPath,
      channel: channel ?? null,
    };
    await publishEvent(eventForRun(result.ok ? TerrariumEventType.Completed : TerrariumEventType.Failed, result));
    if (!channel) return;
    const dir = join(EVENT_DIR, channel);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${result.runId}.json`), `${JSON.stringify(event)}\n`, { flag: "wx" });
  } catch {}
}

async function finishRun(base, patch) {
  const result = { ...base, ...patch, finishedAt: patch.finishedAt ?? new Date().toISOString() };
  await writeMetadata(result);
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
  const pids = [meta.pid, meta.childPid, meta.runnerPid, meta.supervisorPid].filter(Boolean);
  const alive = pids.some(isPidAlive);
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
    return next;
  }
  return { ...meta, alive, logAgeMs };
}

export async function getRunStatus({ runId, staleMs = 30000 } = {}) {
  if (!runId) throw new Error("runId required");
  return await reconcileRun(await readMetadata(runId), { staleMs });
}

export async function superviseTerrariumBackground({ run, parts, prompt, base, workspace, specPath } = {}) {
  const env = { ...process.env, TERRARIUM_RUN_ID: run.runId, TERRARIUM_PARENT_RUN_ID: run.parentRunId ?? "", TERRARIUM_DEPTH: String(run.depth), TERRARIUM_MAX_DEPTH: String(run.maxDepth), TERRARIUM_CHILD_BUDGET: String(process.env.TERRARIUM_CHILD_BUDGET ?? 1), TERRARIUM_MRE_LOG_PATH: run.mreLogPath };
  const child = spawn(parts[0], [...parts.slice(1), prompt], { stdio: ["ignore", "pipe", "pipe"], env, cwd: run.cwd });
  const started = { ok: true, ...base, status: "running", background: true, pid: child.pid, childPid: child.pid, supervisorPid: process.pid, lastSeenAt: new Date().toISOString() };
  await writeMetadata(started);

  return await new Promise((resolveRun) => {
    const timer = run.timeoutMs > 0 ? setTimeout(() => child.kill("SIGTERM"), run.timeoutMs) : null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let lastProgressAt = 0;
    let progressBuffer = "";
    void emitProgressEvent(run, 'started');
    const progress = async (s) => {
      progressBuffer += s;
      const now = Date.now();
      if (now - lastProgressAt < 5000) return;
      lastProgressAt = now;
      const lines = progressBuffer.trim().split(/\r?\n/).filter(Boolean);
      progressBuffer = "";
      if (lines.length) await emitProgressEvent(run, lines.slice(-3).join("\n"));
    };
    const finish = async (patch) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const ws = await finalizeWorkspace(workspace, base);
      const result = await finishRun(base, { background: true, pid: child.pid, childPid: child.pid, supervisorPid: process.pid, stdoutTail: tail(stdout), stderrTail: tail(stderr), ...patch, ...ws });
      if (specPath) await rm(specPath, { force: true });
      resolveRun(result);
    };
    child.stdout.on("data", async (d) => { const s = String(d); stdout += s; await log(run.logPath, s); await progress(s); });
    child.stderr.on("data", async (d) => { const s = String(d); stderr += s; await log(run.logPath, s); await progress(s); });
    child.on("error", async (e) => {
      await log(run.logPath, `\nerror: ${e.message}\n`);
      await finish({ ok: false, status: "error", exitCode: 127, error: e.message });
    });
    child.on("close", async (code, signal) => {
      const exitCode = code ?? (signal ? 128 : 0);
      await log(run.logPath, `\nexit: ${exitCode}${signal ? ` signal: ${signal}` : ""}\n`);
      await finish({ ok: exitCode === 0, status: exitCode === 0 ? "done" : "failed", exitCode, signal });
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
    const env = { ...process.env, TERRARIUM_RUN_ID: run.runId, TERRARIUM_PARENT_RUN_ID: run.parentRunId ?? "", TERRARIUM_DEPTH: String(run.depth), TERRARIUM_MAX_DEPTH: String(run.maxDepth), TERRARIUM_CHILD_BUDGET: String(process.env.TERRARIUM_CHILD_BUDGET ?? 1), TERRARIUM_MRE_LOG_PATH: run.mreLogPath };
    const child = spawn(parts[0], [...parts.slice(1), prompt], { stdio: ["inherit", "pipe", "pipe"], env, cwd: run.cwd });
    const timer = run.timeoutMs > 0 ? setTimeout(() => child.kill("SIGTERM"), run.timeoutMs) : null;

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
      await log(run.logPath, `\nexit: ${exitCode}${signal ? ` signal: ${signal}` : ""}\n`);
      const ws = await finalizeWorkspace(workspace, base);
      resolve(await finishRun(base, { ok: exitCode === 0, status: exitCode === 0 ? "done" : "failed", exitCode, signal, stdoutTail: tail(stdout), stderrTail: tail(stderr), ...ws }));
    });
  });
}

export async function listRuns({ limit = 20 } = {}) {
  await mkdir(LOG_DIR, { recursive: true });
  const files = (await readdir(LOG_DIR)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
  const runs = [];
  for (const file of files) runs.push(await reconcileRun(JSON.parse(await readFile(join(LOG_DIR, file), "utf8"))));
  return { version: VERSION, logDir: LOG_DIR, runs };
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
  const files = (await readdir(LOG_DIR)).filter((file) => file.endsWith(".json"));
  for (const file of files) {
    const meta = JSON.parse(await readFile(join(LOG_DIR, file), "utf8"));
    const expected = kind === "terrarium" ? meta.logPath : meta.mreLogPath;
    if (expected && resolve(expected) === requested) {
      if (!meta.logPathExternal && !meta.mreLogPathExternal) confinedLogPath(expected, "recorded log path");
      return expected;
    }
  }
  throw new Error("logPath is not a recorded Terrarium log");
}

export async function readRun({ runId, logPath, kind = "terrarium", tailBytes = 20000 } = {}) {
  const readablePath = await recordedLogPath({ runId, logPath, kind });
  const text = await readFile(readablePath, "utf8");
  return { kind, logPath: readablePath, text: tail(text, tailBytes) };
}
