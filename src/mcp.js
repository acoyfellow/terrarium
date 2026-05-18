#!/usr/bin/env node
import { createInterface } from "node:readline";
import { getRunStatus, listRuns, readRun, runTerrarium, spawnTerrariumBackground, VERSION } from "./core.js";

const tools = [
  {
    name: "terrarium_spawn",
    description: "Spawn exactly one child agent for one delegated task. Use this when a subtask would pollute parent context: repo archaeology, log digs, design research, failing-test diagnosis. Returns structured result and log path. Use background=true for long-running tasks to avoid MCP timeouts (then poll with terrarium_status / terrarium_read).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The single bounded objective for the child agent. Be specific. Include 'do not edit files' for read-only digs." },
        agent: { type: "string", description: "Child command. Default: 'opencode run'. Examples: 'opencode run', 'pi run'." },
        cwd: { type: "string", description: "Working directory for the child. Default: current directory." },
        timeoutMs: { type: "number", description: "Kill the child after this many milliseconds. Default: none." },
        maxDepth: { type: "number", description: "Maximum Terrarium recursion depth. Default: 3." },
        dryRun: { type: "boolean", description: "Print the child invocation without running it." },
        background: { type: "boolean", description: "Detach and return immediately with runId/pid/logPath. Required for long agent tasks; poll via terrarium_status." },
        logPath: { type: "string", description: "Override log file path. Default: ~/.terrarium/runs/<runId>.log" },
        mreLogPath: { type: "string", description: "Override MRE log file path passed to the child as TERRARIUM_MRE_LOG_PATH. Default: ~/.terrarium/runs/<runId>.mre.log" }
      },
      required: ["task"]
    }
  },
  {
    name: "terrarium_status",
    description: "List recent Terrarium runs with metadata, or get status for a single run. Use this to poll a background spawn until it finishes.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max number of recent runs to return. Default: 20." },
        runId: { type: "string", description: "If set, return status for this single run instead of listing." }
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

function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
function content(obj, isError = false) { return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], isError }; }

async function handle(msg) {
  if (msg.method === "initialize") return send(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "terrarium", version: VERSION } });
  if (msg.method === "tools/list") return send(msg.id, { tools });
  if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params ?? {};
    try {
      if (name === "terrarium_spawn") {
        const result = args.background ? await spawnTerrariumBackground(args) : await runTerrarium({ ...args, stream: false });
        return send(msg.id, content(result, !result.ok));
      }
      if (name === "terrarium_status") return send(msg.id, content(args.runId ? await getRunStatus(args) : await listRuns(args)));
      if (name === "terrarium_read") return send(msg.id, content(await readRun(args)));
      return error(msg.id, -32602, `unknown tool: ${name}`);
    } catch (e) {
      return send(msg.id, content(e.message, true));
    }
  }
  if (msg.id) return error(msg.id, -32601, `unknown method: ${msg.method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try { await handle(JSON.parse(line)); }
  catch (e) { error(null, -32700, e.message); }
});
