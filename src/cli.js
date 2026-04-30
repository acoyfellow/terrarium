#!/usr/bin/env node
import { listRuns, readRun, runTerrarium, VERSION } from "./core.js";

function help() {
  return `terrarium ${VERSION}

A tiny orchestrator. It accepts one task and may run exactly one child agent.
The child agent may be Terrarium too, with depth guards.

Usage:
  terra "task to run"
  terra --agent "opencode run" "task"
  terra --dry-run "task"
  terra --json "task"
  terra status
  terra read <runId>

Options:
  --agent <cmd>      Child command. Default: config, $TERRARIUM_AGENT, or "opencode run"
  --cwd <path>       Child working directory. Default: current directory
  --timeout-ms <n>   Kill child after n milliseconds. Default: config or no timeout
  --max-depth <n>    Maximum Terrarium depth. Default: config or 3
  --dry-run          Print the child invocation without running it
  --json             Print structured JSON result
  --log <path>       Write a transcript to this path
  --help             Show help
  --version          Show version
`;
}

function parse(argv) {
  const out = { dryRun: false, json: false, logPath: null, cwd: process.cwd(), task: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a === "--agent") out.agent = argv[++i];
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--max-depth") out.maxDepth = Number(argv[++i]);
    else if (a === "--log") out.logPath = argv[++i];
    else out.task.push(a);
  }
  return out;
}

const opts = parse(process.argv.slice(2));
const [cmd, ...rest] = opts.task;
if (opts.help) console.log(help());
else if (opts.version) console.log(VERSION);
else if (cmd === "status") listRuns({ limit: Number(rest[0] || 20) }).then((r) => console.log(JSON.stringify(r, null, 2)));
else if (cmd === "read") readRun({ runId: rest[0], tailBytes: Number(rest[1] || 20000) }).then((r) => console.log(r.text));
else runTerrarium({ ...opts, task: opts.task.join(" ").trim(), stream: !opts.json }).then((result) => {
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  process.exit(result.exitCode ?? (result.ok ? 0 : 1));
}).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
