#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapServer } from "mcp-code-mode";
import { createQuickJSSandbox } from "mcp-code-mode/sandbox/quickjs";
import { SecureWorkspace, SECURE_TOOL_SCHEMAS } from "./secure-workspace.js";

const container = process.env.TERRARIUM_SECURE_CONTAINER;
if (!container || !/^terrarium-secure-[a-z0-9-]+$/.test(container)) throw new Error("valid TERRARIUM_SECURE_CONTAINER required");
const workspace = new SecureWorkspace(container);
const receiptPath = process.env.TERRARIUM_SECURE_RECEIPT_PATH;
let finished = false;
const server = new Server({ name: "terrarium-secure", version: "0.1.0" }, { capabilities: { tools: {} } });
const finishSchema = { name: "finish", description: "Finish the secure task. Runs tests and returns the bounded change receipt. Call exactly once when done.", inputSchema: { type: "object", properties: {} } };
const schemas = [...SECURE_TOOL_SCHEMAS, finishSchema];

const handlers = {
  list_files: (args) => workspace.listFiles(args),
  read_file: (args) => workspace.readFile(args),
  search_text: (args) => workspace.searchText(args),
  write_file: (args) => workspace.writeFile(args),
  run_tests: (args) => workspace.runTests(args),
  get_diff: () => workspace.getDiff(),
  finish: async () => {
    if (finished) throw new Error("secure task already finished");
    finished = true;
    const value = { tests: workspace.runTests({}), diff: workspace.getDiff(), finished: true, finishedAt: new Date().toISOString() };
    if (receiptPath) await writeFile(receiptPath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    return value;
  },
};

const toolkit = {
  async listTools() { return schemas; },
  async callTool(name, args) {
    const handler = handlers[name];
    if (!handler) return { isError: true, content: [{ type: "text", text: `Unknown secure tool: ${name}` }] };
    try {
      const value = await handler(args || {});
      return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  },
};

wrapServer(server, toolkit, {
  expose: SECURE_TOOL_SCHEMAS.map((tool) => tool.name),
  keepNative: ["finish"],
  sandbox: await createQuickJSSandbox(),
  audit: "metadata",
  limits: { maxToolCalls: 60, maxConcurrentCalls: 4, maxCodeBytes: 32 * 1024, maxLogBytes: 32 * 1024, maxResultBytes: 1024 * 1024 },
  executeTool: { defaultTimeoutMs: 15000, maxTimeoutMs: 30000 },
});

await server.connect(new StdioServerTransport());
