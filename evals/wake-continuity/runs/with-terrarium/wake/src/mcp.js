#!/usr/bin/env node
import { createInterface } from "node:readline";
import { cmdHandoff, cmdNote, cmdResume, cmdStatus, VERSION } from "./wake.js";

const tools = [
  {
    name: "wake_resume",
    description: "Get the handoff for the current or most recent Wake run. Call this first when resuming work after terminal/session loss.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } }
  },
  {
    name: "wake_note",
    description: "Append a structured note to the active Wake run: decision, attempt, command, failure, file, next, or note.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, kind: { type: "string" }, text: { type: "string" }, file: { type: "string" }, cmd: { type: "string" }, exit: { type: "number" }, ok: { type: "boolean" }, outputTail: { type: "string" } }, required: ["kind"] }
  },
  {
    name: "wake_handoff",
    description: "Close a Wake run and return the generated HANDOFF.md text plus path.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, summary: { type: "string" }, next: { type: "string" } } }
  },
  {
    name: "wake_status",
    description: "Return structured status for the current, active, last, or specified Wake run.",
    inputSchema: { type: "object", properties: { id: { type: "string" } } }
  }
];

function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
function content(obj, isError = false) { return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], isError }; }

async function handle(msg) {
  if (msg.method === "initialize") return send(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "wake", version: VERSION } });
  if (msg.method === "tools/list") return send(msg.id, { tools });
  if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params ?? {};
    try {
      if (name === "wake_resume") return send(msg.id, content(cmdResume(args).text ?? cmdResume(args).message, !cmdResume(args).ok));
      if (name === "wake_status") return send(msg.id, content(cmdStatus({ ...args, json: true })));
      if (name === "wake_note") return send(msg.id, content(cmdNote({ id: args.id, kind: args.kind, text: args.text, path: args.file, cmd: args.cmd, exit: args.exit, ok: args.ok, outputTail: args.outputTail })));
      if (name === "wake_handoff") return send(msg.id, content(cmdHandoff(args)));
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
