#!/usr/bin/env node
import { createInterface } from "node:readline";
import { runTerrarium, VERSION } from "./core.js";

const tools = [{
  name: "terrarium_spawn",
  description: "Spawn exactly one child agent for one delegated task. Returns structured result and log path.",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task to delegate to the child agent." },
      agent: { type: "string", description: "Child command. Default: $TERRARIUM_AGENT or opencode run." },
      cwd: { type: "string", description: "Working directory for the child." },
      timeoutMs: { type: "number", description: "Kill child after this many milliseconds. 0 means no timeout." },
      dryRun: { type: "boolean", description: "Return the invocation without running the child." },
      logPath: { type: "string", description: "Transcript path." }
    },
    required: ["task"]
  }
}];

function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

async function handle(msg) {
  if (msg.method === "initialize") return send(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "terrarium", version: VERSION } });
  if (msg.method === "tools/list") return send(msg.id, { tools });
  if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params ?? {};
    if (name !== "terrarium_spawn") return error(msg.id, -32602, `unknown tool: ${name}`);
    try {
      const result = await runTerrarium({ ...args, stream: false });
      return send(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: !result.ok });
    } catch (e) {
      return send(msg.id, { content: [{ type: "text", text: e.message }], isError: true });
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
