import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VERSION = "0.0.1";
export const HOME = join(homedir(), ".terrarium");
export const LOG_DIR = join(HOME, "runs");
export const CONFIG_PATH = join(HOME, "config.json");

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

function tail(text, max = 12000) {
  return text.length > max ? text.slice(-max) : text;
}

async function gitInfo(cwd) {
  async function git(args) {
    return await new Promise((resolve) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (d) => out += String(d));
      child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
      child.on("error", () => resolve(null));
    });
  }
  const root = await git(["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  return { root, head: await git(["rev-parse", "HEAD"]), status: await git(["status", "--short"]) };
}

async function writeMetadata(meta) {
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(metadataPath(meta.runId), JSON.stringify(meta, null, 2) + "\n");
}

export async function runTerrarium(opts = {}) {
  const config = await loadConfig();
  const runId = opts.runId || makeRunId();
  const parentRunId = opts.parentRunId || process.env.TERRARIUM_RUN_ID || null;
  const depth = Number(opts.depth ?? process.env.TERRARIUM_DEPTH ?? 0) + 1;
  const maxDepth = Number(opts.maxDepth ?? process.env.TERRARIUM_MAX_DEPTH ?? config.maxDepth ?? 3);
  const agent = opts.agent || process.env.TERRARIUM_AGENT || config.defaultAgent || "opencode run";
  const timeoutMs = Number(opts.timeoutMs ?? config.timeoutMs ?? 0);
  const { task, dryRun = false, cwd = process.cwd(), stream = true } = opts;
  let { logPath } = opts;

  if (!task) throw new Error("missing task");
  if (depth > maxDepth) throw new Error(`Terrarium max depth exceeded (${depth}/${maxDepth})`);
  const parts = splitCommand(agent);
  if (parts.length === 0) throw new Error("empty agent command");

  const prompt = childPrompt(task, { depth, maxDepth, runId, parentRunId });
  logPath ??= await defaultLogPath(runId);
  const startedAt = new Date().toISOString();
  const base = { runId, parentRunId, depth, maxDepth, version: VERSION, agent, task, cwd, logPath, startedAt, status: "running", git: await gitInfo(cwd) };
  await writeMetadata(base);

  const header = `terrarium ${VERSION}\nrun: ${runId}\nparent: ${parentRunId ?? "none"}\ndepth: ${depth}/${maxDepth}\nagent: ${agent}\ntask: ${task}\ncwd: ${cwd}\nlog: ${logPath}\n\n`;
  if (stream) process.stdout.write(header);
  await writeFile(logPath, header);

  if (dryRun) {
    const invocation = `${parts.join(" ")} ${JSON.stringify(prompt)}\n`;
    if (stream) process.stdout.write(invocation);
    await log(logPath, invocation);
    const result = { ok: true, dryRun: true, ...base, status: "done", finishedAt: new Date().toISOString(), invocation, exitCode: 0, stdoutTail: invocation, stderrTail: "" };
    await writeMetadata(result);
    return result;
  }

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const env = { ...process.env, TERRARIUM_RUN_ID: runId, TERRARIUM_PARENT_RUN_ID: parentRunId ?? "", TERRARIUM_DEPTH: String(depth), TERRARIUM_MAX_DEPTH: String(maxDepth) };
    const child = spawn(parts[0], [...parts.slice(1), prompt], { stdio: ["inherit", "pipe", "pipe"], env, cwd });
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill("SIGTERM"), timeoutMs) : null;

    child.stdout.on("data", async (d) => { const s = String(d); stdout += s; if (stream) process.stdout.write(d); await log(logPath, s); });
    child.stderr.on("data", async (d) => { const s = String(d); stderr += s; if (stream) process.stderr.write(d); await log(logPath, s); });
    child.on("error", async (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      await log(logPath, `\nerror: ${e.message}\n`);
      const result = { ok: false, ...base, status: "error", finishedAt: new Date().toISOString(), exitCode: 127, error: e.message, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
      await writeMetadata(result);
      resolve(result);
    });
    child.on("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 : 0);
      await log(logPath, `\nexit: ${exitCode}${signal ? ` signal: ${signal}` : ""}\n`);
      const result = { ok: exitCode === 0, ...base, status: exitCode === 0 ? "done" : "failed", finishedAt: new Date().toISOString(), exitCode, signal, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
      await writeMetadata(result);
      resolve(result);
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
