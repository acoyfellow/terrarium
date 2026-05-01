#!/usr/bin/env node
import { createInterface } from "node:readline";
import { listRuns, readRun, runTerrarium, spawnTerrariumBackground, VERSION } from "./core.js";

const tools = [
  {
    name: "terrarium_spawn",
    description: "Spawn exactly one child agent for one delegated task. Returns structured result and log path. Use background=true for long-running agent tasks to avoid MCP timeouts.",
    inputSchema: { type: "object", properties: { task: { type: "string" }, agent: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" }, maxDepth: { type: "number" }, dryRun: { type: "boolean" }, background: { type: "boolean" }, logPath: { type: "string" } }, required: ["task"] }
  },
  {
    name: "terrarium_status",
    description: "List recent Terrarium runs with metadata.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } }
  },
  {
    name: "terrarium_read",
    description: "Read the tail of a Terrarium run log by runId or logPath.",
    inputSchema: { type: "object", properties: { runId: { type: "string" }, logPath: { type: "string" }, tailBytes: { type: "number" } } }
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
      if (name === "terrarium_status") return send(msg.id, content(await listRuns(args)));
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
