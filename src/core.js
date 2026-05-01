import { spawn } from "node:child_process";
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const VERSION = "0.0.1";
export const HOME = join(homedir(), ".terrarium");
export const LOG_DIR = join(HOME, "runs");
export const CONFIG_PATH = join(HOME, "config.json");
export const WORKSPACE_DIR = join(HOME, "workspaces");

export function splitCommand(command) {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^[']|[']$/g, "").replace(/^[\"]|[\"]$/g, "")) ?? [];
}

export function makeRunId() {
  return `ter_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${Math.random().toString(36).slice(2, 8)}`;
}

export function childPrompt(task, { depth, maxDepth, runId, parentRunId } = {}) {
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

export async function defaultLogPath(runId) {
  await mkdir(LOG_DIR, { recursive: true });
  return join(LOG_DIR, `${runId}.log`);
}

export function metadataPath(runId) {
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

async function gitInfo(cwd) {
  async function git(args) {
    const r = await spawnCapture("git", args, { cwd });
    return r.code === 0 ? r.stdout.trim() : null;
  }
  const root = await git(["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  return { root, head: await git(["rev-parse", "HEAD"]), status: await git(["status", "--short"]) };
}

async function writeMetadata(meta) {
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(metadataPath(meta.runId), JSON.stringify(meta, null, 2) + "\n");
}

function buildRun(opts, config) {
  const runId = opts.runId || makeRunId();
  const parentRunId = opts.parentRunId || process.env.TERRARIUM_RUN_ID || null;
  const depth = Number(opts.depth ?? process.env.TERRARIUM_DEPTH ?? 0) + 1;
  const maxDepth = Number(opts.maxDepth ?? process.env.TERRARIUM_MAX_DEPTH ?? config.maxDepth ?? 3);
  const agent = opts.agent || process.env.TERRARIUM_AGENT || config.defaultAgent || "opencode run";
  const timeoutMs = Number(opts.timeoutMs ?? config.timeoutMs ?? 0);
  const { task, dryRun = false, cwd = process.cwd(), stream = true } = opts;
  const isolation = opts.isolation || config.isolation || "none";
  const keepWorkspace = Boolean(opts.keepWorkspace ?? config.keepWorkspace ?? false);
  return { runId, parentRunId, depth, maxDepth, agent, timeoutMs, task, dryRun, cwd, originalCwd: cwd, stream, logPath: opts.logPath, isolation, keepWorkspace };
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
    const root = (await gitInfo(run.originalCwd))?.root;
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

async function prepareRun(opts = {}) {
  const config = await loadConfig();
  const run = buildRun(opts, config);
  if (!run.task) throw new Error("missing task");
  if (run.depth > run.maxDepth) throw new Error(`Terrarium max depth exceeded (${run.depth}/${run.maxDepth})`);
  const parts = splitCommand(run.agent);
  if (parts.length === 0) throw new Error("empty agent command");
  const workspace = await prepareWorkspace(run);
  const prompt = childPrompt(run.task, run);
  run.logPath ??= await defaultLogPath(run.runId);
  const startedAt = new Date().toISOString();
  const base = { runId: run.runId, parentRunId: run.parentRunId, depth: run.depth, maxDepth: run.maxDepth, version: VERSION, agent: run.agent, task: run.task, cwd: run.cwd, originalCwd: run.originalCwd, isolation: run.isolation, workspace, logPath: run.logPath, startedAt, status: "running", git: await gitInfo(run.cwd) };
  await writeMetadata(base);
  const header = `terrarium ${VERSION}\nrun: ${run.runId}\nparent: ${run.parentRunId ?? "none"}\ndepth: ${run.depth}/${run.maxDepth}\nagent: ${run.agent}\ntask: ${run.task}\ncwd: ${run.cwd}\noriginal cwd: ${run.originalCwd}\nisolation: ${run.isolation}${workspace ? ` (${workspace.path})` : ""}\nlog: ${run.logPath}\n\n`;
  if (run.stream) process.stdout.write(header);
  await writeFile(run.logPath, header);
  return { run, parts, prompt, base, workspace };
}

async function finishRun(base, patch) {
  const result = { ...base, ...patch, finishedAt: patch.finishedAt ?? new Date().toISOString() };
  await writeMetadata(result);
  return result;
}

export async function spawnTerrariumBackground(opts = {}) {
  const { run, parts, prompt, base, workspace } = await prepareRun({ ...opts, stream: false });
  const invocation = `${parts.join(" ")} ${JSON.stringify(prompt)}\n`;
  if (run.dryRun) {
    await log(run.logPath, invocation);
    const ws = await finalizeWorkspace(workspace, base);
    return finishRun(base, { ok: true, dryRun: true, status: "done", invocation, exitCode: 0, stdoutTail: invocation, stderrTail: "", ...ws });
  }

  const env = { ...process.env, TERRARIUM_RUN_ID: run.runId, TERRARIUM_PARENT_RUN_ID: run.parentRunId ?? "", TERRARIUM_DEPTH: String(run.depth), TERRARIUM_MAX_DEPTH: String(run.maxDepth) };
  const child = spawn(parts[0], [...parts.slice(1), prompt], { stdio: ["ignore", "pipe", "pipe"], env, cwd: run.cwd, detached: true });
  const started = { ok: true, ...base, status: "running", background: true, pid: child.pid };
  await writeMetadata(started);

  const timer = run.timeoutMs > 0 ? setTimeout(() => child.kill("SIGTERM"), run.timeoutMs) : null;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", async (d) => { const s = String(d); stdout += s; await log(run.logPath, s); });
  child.stderr.on("data", async (d) => { const s = String(d); stderr += s; await log(run.logPath, s); });
  child.on("error", async (e) => {
    if (timer) clearTimeout(timer);
    await log(run.logPath, `\nerror: ${e.message}\n`);
    const ws = await finalizeWorkspace(workspace, base);
    await finishRun(base, { ok: false, status: "error", background: true, pid: child.pid, exitCode: 127, error: e.message, stdoutTail: tail(stdout), stderrTail: tail(stderr), ...ws });
  });
  child.on("close", async (code, signal) => {
    if (timer) clearTimeout(timer);
    const exitCode = code ?? (signal ? 128 : 0);
    await log(run.logPath, `\nexit: ${exitCode}${signal ? ` signal: ${signal}` : ""}\n`);
    const ws = await finalizeWorkspace(workspace, base);
    await finishRun(base, { ok: exitCode === 0, status: exitCode === 0 ? "done" : "failed", background: true, pid: child.pid, exitCode, signal, stdoutTail: tail(stdout), stderrTail: tail(stderr), ...ws });
  });
  child.unref();
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
    const env = { ...process.env, TERRARIUM_RUN_ID: run.runId, TERRARIUM_PARENT_RUN_ID: run.parentRunId ?? "", TERRARIUM_DEPTH: String(run.depth), TERRARIUM_MAX_DEPTH: String(run.maxDepth) };
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
  for (const file of files) runs.push(JSON.parse(await readFile(join(LOG_DIR, file), "utf8")));
  return { version: VERSION, logDir: LOG_DIR, runs };
}

export async function readRun({ runId, logPath, tailBytes = 20000 } = {}) {
  if (!logPath) {
    if (!runId) throw new Error("runId or logPath required");
    logPath = join(LOG_DIR, `${runId}.log`);
  }
  const text = await readFile(logPath, "utf8");
  return { logPath, text: tail(text, tailBytes) };
}
