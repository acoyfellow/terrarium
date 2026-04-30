#!/usr/bin/env node
import { runTerrarium, VERSION } from "./core.js";

function help() {
  return `terrarium ${VERSION}

A tiny orchestrator. It accepts one task and may run exactly one child agent.
The child agent may be Terrarium too, which is how you compose shells without
letting any single agent recurse deeper than one level.

Usage:
  terra "task to run"
  terra --agent "opencode run" "task"
  terra --dry-run "task"
  terra --json "task"

Options:
  --agent <cmd>      Child command. Default: $TERRARIUM_AGENT or "opencode run"
  --cwd <path>       Child working directory. Default: current directory
  --timeout-ms <n>   Kill child after n milliseconds. Default: no timeout
  --dry-run          Print the child invocation without running it
  --json             Print structured JSON result
  --log <path>       Write a transcript to this path
  --help             Show help
  --version          Show version
`;
}

function parse(argv) {
  const out = { agent: process.env.TERRARIUM_AGENT || "opencode run", dryRun: false, json: false, logPath: null, cwd: process.cwd(), timeoutMs: 0, task: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a === "--agent") out.agent = argv[++i];
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--log") out.logPath = argv[++i];
    else out.task.push(a);
  }
  out.task = out.task.join(" ").trim();
  return out;
}

const opts = parse(process.argv.slice(2));
if (opts.help) console.log(help());
else if (opts.version) console.log(VERSION);
else runTerrarium({ ...opts, stream: !opts.json }).then((result) => {
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  process.exit(result.exitCode ?? (result.ok ? 0 : 1));
}).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
