import { spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VERSION = "0.0.1";
export const LOG_DIR = join(homedir(), ".terrarium", "runs");

export function splitCommand(command) {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^['"]|['"]$/g, "")) ?? [];
}

export function childPrompt(task) {
  return `You are a Terrarium child agent. Complete the task directly. You may orchestrate at most one child of your own; do not create fan-out or deeper recursion inside this process. Return concise results and changed file paths.\n\nTask:\n${task}`;
}

export async function defaultLogPath() {
  await mkdir(LOG_DIR, { recursive: true });
  return join(LOG_DIR, `${new Date().toISOString().replaceAll(":", "-")}.log`);
}

async function log(path, line) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line);
}

function tail(text, max = 12000) {
  return text.length > max ? text.slice(-max) : text;
}

export async function runTerrarium({ agent = process.env.TERRARIUM_AGENT || "opencode run", task, dryRun = false, logPath, cwd = process.cwd(), timeoutMs = 0, stream = true } = {}) {
  if (!task) throw new Error("missing task");
  const parts = splitCommand(agent);
  if (parts.length === 0) throw new Error("empty agent command");
  const prompt = childPrompt(task);
  logPath ??= await defaultLogPath();

  const header = `terrarium ${VERSION}\nagent: ${agent}\ntask: ${task}\ncwd: ${cwd}\nlog: ${logPath}\n\n`;
  if (stream) process.stdout.write(header);
  await writeFile(logPath, header);

  if (dryRun) {
    const invocation = `${parts.join(" ")} ${JSON.stringify(prompt)}\n`;
    if (stream) process.stdout.write(invocation);
    await log(logPath, invocation);
    return { ok: true, dryRun: true, version: VERSION, agent, task, cwd, logPath, invocation, exitCode: 0, stdoutTail: invocation, stderrTail: "" };
  }

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(parts[0], [...parts.slice(1), prompt], { stdio: ["inherit", "pipe", "pipe"], env: process.env, cwd });
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill("SIGTERM"), timeoutMs) : null;

    child.stdout.on("data", async (d) => { const s = String(d); stdout += s; if (stream) process.stdout.write(d); await log(logPath, s); });
    child.stderr.on("data", async (d) => { const s = String(d); stderr += s; if (stream) process.stderr.write(d); await log(logPath, s); });
    child.on("error", async (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      await log(logPath, `\nerror: ${e.message}\n`);
      resolve({ ok: false, version: VERSION, agent, task, cwd, logPath, exitCode: 127, error: e.message, stdoutTail: tail(stdout), stderrTail: tail(stderr) });
    });
    child.on("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 : 0);
      await log(logPath, `\nexit: ${exitCode}${signal ? ` signal: ${signal}` : ""}\n`);
      resolve({ ok: exitCode === 0, version: VERSION, agent, task, cwd, logPath, exitCode, signal, stdoutTail: tail(stdout), stderrTail: tail(stderr) });
    });
  });
}
