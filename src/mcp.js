#!/usr/bin/env node
import { createInterface } from "node:readline";
import { getRunStatus, listRuns, readRun, runTerrarium, spawnTerrariumBackground, VERSION } from "./core.js";

const tools = [
  {
    name: "terrarium_spawn",
    description: "Spawn exactly one child agent for one delegated task. Use this when a subtask would pollute parent context: repo archaeology, log digs, design research, failing-test diagnosis. Returns a concise structured result (runId, status, ok, exitCode, capped tail). Pass verbose=true to get the full envelope. Use background=true for long-running tasks to avoid MCP timeouts (then poll with terrarium_status / terrarium_read).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The single bounded objective for the child agent. Be specific. Include 'do not edit files' for read-only digs." },
        agent: { type: "string", description: "Child command. Explicit agent overrides readOnly preset. Default: 'opencode run'. Examples: 'opencode run', 'pi run'." },
        readOnly: { type: "boolean", description: "Use the read-only child preset (opencode run --agent explore) when no explicit agent is given. Good for read-only digs (repo archaeology, log digs, design research)." },
        profile: { type: "string", enum: ["default", "minimal"], description: "Child prompt profile. 'default' (full structured contract) or 'minimal' (lean shell for bounded read-only digs). Orthogonal to agent/readOnly. Default: 'default'." },
        cwd: { type: "string", description: "Working directory for the child. Default: current directory." },
        timeoutMs: { type: "number", description: "Kill the child after this many milliseconds. Default: none." },
        maxDepth: { type: "number", description: "Maximum Terrarium recursion depth. Default: 3." },
        dryRun: { type: "boolean", description: "Print the child invocation without running it." },
        background: { type: "boolean", description: "Detach and return immediately with a concise run pointer by default. Pass verbose=true for pid/logPath fields. Required for long agent tasks; poll via terrarium_status." },
        logPath: { type: "string", description: "Override log file path. Default: ~/.terrarium/runs/<runId>.log" },
        mreLogPath: { type: "string", description: "Override MRE log file path passed to the child as TERRARIUM_MRE_LOG_PATH. Default: ~/.terrarium/runs/<runId>.mre.log" },
        verbose: { type: "boolean", description: "Return the full unprojected result envelope. Default: false (concise projection)." }
      },
      required: ["task"]
    }
  },
  {
    name: "terrarium_status",
    description: "List recent Terrarium runs with metadata, or get status for a single run. By default returns a concise projection that preserves triage fields (status, ok, background, alive, exitCode, signal, error, note, timestamps). Pass verbose=true for the full envelope. Use this to poll a background spawn until it finishes.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max number of recent runs to return. Default: 20." },
        runId: { type: "string", description: "If set, return status for this single run instead of listing." },
        verbose: { type: "boolean", description: "Return the full unprojected envelope per run. Default: false (concise projection)." }
      }
    }
  },
  {
    name: "terrarium_read",
    description: "Read the tail of a Terrarium run log by runId or logPath. Use this to inspect a child's output, especially after a background spawn completes.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run ID returned by terrarium_spawn." },
        logPath: { type: "string", description: "Recorded Terrarium log path. Use this or runId." },
        kind: { type: "string", enum: ["terrarium", "mre"], description: "Log kind to read by runId. Default: terrarium." },
        tailBytes: { type: "number", description: "Bytes from the end of the log to return. Default: 20000." }
      }
    }
  }
];

const SPAWN_TAIL_CAP = 2000;
const SPAWN_ERR_TAIL_CAP = 500;

function defined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function capTail(s, cap) {
  if (typeof s !== "string" || s.length === 0) return undefined;
  return s.length > cap ? s.slice(-cap) : s;
}

export function conciseSpawn(full) {
  if (!full || typeof full !== "object") return full;
  const tail = capTail(full.stdoutTail, SPAWN_TAIL_CAP);
  const errTail = capTail(full.stderrTail, SPAWN_ERR_TAIL_CAP);
  return defined({
    ok: full.ok,
    runId: full.runId,
    status: full.status,
    background: full.background ? true : undefined,
    exitCode: full.exitCode,
    signal: full.signal,
    error: full.error,
    note: full.note,
    startedAt: full.startedAt,
    finishedAt: full.finishedAt,
    tail,
    tailTruncated: typeof full.stdoutTail === "string" && full.stdoutTail.length > SPAWN_TAIL_CAP ? true : undefined,
    errTail,
  });
}

export function conciseStatus(full) {
  if (!full || typeof full !== "object") return full;
  return defined({
    runId: full.runId,
    status: full.status,
    ok: full.ok,
    background: full.background ? true : undefined,
    alive: typeof full.alive === "boolean" ? full.alive : undefined,
    exitCode: full.exitCode,
    signal: full.signal,
    error: full.error,
    note: full.note,
    logAgeMs: full.logAgeMs,
    startedAt: full.startedAt,
    finishedAt: full.finishedAt,
    orphanedAt: full.orphanedAt,
  });
}

export function conciseListing(full) {
  if (!full || !Array.isArray(full.runs)) return full;
  return {
    count: full.runs.length,
    runs: full.runs.map((r) => defined({
      runId: r.runId,
      status: r.status,
      ok: r.ok,
      background: r.background ? true : undefined,
      alive: typeof r.alive === "boolean" ? r.alive : undefined,
      exitCode: r.exitCode,
      signal: r.signal,
      error: r.error,
      note: r.note,
      logAgeMs: r.logAgeMs,
      orphanedAt: r.orphanedAt,
      task: typeof r.task === "string" && r.task.length > 80 ? r.task.slice(0, 77) + "..." : r.task,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    })),
  };
}

function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
function content(obj, isError = false) { return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], isError }; }

async function handle(msg) {
  if (msg.method === "initialize") return send(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "terrarium", version: VERSION } });
  if (msg.method === "tools/list") return send(msg.id, { tools });
  if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params ?? {};
    const verbose = args.verbose === true;
    try {
      if (name === "terrarium_spawn") {
        const result = args.background ? await spawnTerrariumBackground(args) : await runTerrarium({ ...args, stream: false });
        const projected = verbose ? result : conciseSpawn(result);
        return send(msg.id, content(projected, !result.ok));
      }
      if (name === "terrarium_status") {
        if (args.runId) {
          const result = await getRunStatus(args);
          return send(msg.id, content(verbose ? result : conciseStatus(result)));
        }
        const result = await listRuns(args);
        return send(msg.id, content(verbose ? result : conciseListing(result)));
      }
      if (name === "terrarium_read") return send(msg.id, content(await readRun(args)));
      return error(msg.id, -32602, `unknown tool: ${name}`);
    } catch (e) {
      return send(msg.id, content(e.message, true));
    }
  }
  if (msg.id) return error(msg.id, -32601, `unknown method: ${msg.method}`);
}

// Always attach stdio when invoked as this executable. The previous
// import.meta.url/process.argv comparison was brittle when launchers resolve a
// symlink to terrarium-mcp differently from Node, which made Pi see an MCP
// process that exited before initialize.
const isMainEntry = /(?:^|\/)(?:mcp\.js|terrarium-mcp)$/.test(process.argv[1] ?? "");

if (isMainEntry) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try { await handle(JSON.parse(line)); }
    catch (e) { error(null, -32700, e.message); }
  });
}
