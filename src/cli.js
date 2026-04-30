#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.0.1";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_DIR = join(homedir(), ".terrarium", "runs");

function help() {
  return `terrarium ${VERSION}

A tiny orchestrator. It accepts one task and may run exactly one child agent.
The child agent may be Terrarium too, which is how you compose shells without
letting any single agent recurse deeper than one level.

Usage:
  terra "task to run"
  terra --agent "opencode run" "task"
  terra --dry-run "task"

Options:
  --agent <cmd>   Child command. Default: $TERRARIUM_AGENT or "opencode run"
  --dry-run       Print the child invocation without running it
  --log <path>    Write a transcript to this path
  --help          Show help
  --version       Show version
`;
}

function parse(argv) {
  const out = { agent: process.env.TERRARIUM_AGENT || "opencode run", dryRun: false, log: null, task: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--agent") out.agent = argv[++i];
    else if (a === "--log") out.log = argv[++i];
    else out.task.push(a);
  }
  out.task = out.task.join(" ").trim();
  return out;
}

function splitCommand(command) {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^['"]|['"]$/g, "")) ?? [];
}

async function defaultLogPath() {
  await mkdir(LOG_DIR, { recursive: true });
  return join(LOG_DIR, `${new Date().toISOString().replaceAll(":", "-")}.log`);
}

async function log(path, line) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line);
}

function childPrompt(task) {
  return `You are a Terrarium child agent. Complete the task directly. You may orchestrate at most one child of your own; do not create fan-out or deeper recursion inside this process. Return concise results and changed file paths.\n\nTask:\n${task}`;
}

async function run({ agent, task, dryRun, log: logPath }) {
  if (!task) throw new Error("missing task");
  const parts = splitCommand(agent);
  if (parts.length === 0) throw new Error("empty agent command");
  const prompt = childPrompt(task);
  logPath ??= await defaultLogPath();

  const header = `terrarium ${VERSION}\nagent: ${agent}\ntask: ${task}\nlog: ${logPath}\n\n`;
  process.stdout.write(header);
  await writeFile(logPath, header);

  if (dryRun) {
    const text = `${parts.join(" ")} ${JSON.stringify(prompt)}\n`;
    process.stdout.write(text);
    await log(logPath, text);
    return 0;
  }

  return await new Promise((resolve) => {
    const child = spawn(parts[0], [...parts.slice(1), prompt], { stdio: ["inherit", "pipe", "pipe"], env: process.env });
    child.stdout.on("data", async (d) => { process.stdout.write(d); await log(logPath, d); });
    child.stderr.on("data", async (d) => { process.stderr.write(d); await log(logPath, d); });
    child.on("error", async (e) => { await log(logPath, `\nerror: ${e.message}\n`); resolve(127); });
    child.on("close", async (code) => { await log(logPath, `\nexit: ${code ?? 0}\n`); resolve(code ?? 0); });
  });
}

const opts = parse(process.argv.slice(2));
if (opts.help) console.log(help());
else if (opts.version) console.log(VERSION);
else run(opts).then((code) => process.exit(code)).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
