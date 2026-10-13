import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";

import { Schema } from "effect";

const RUN_ID = "ter_abc123_0123456789ab";

const SUMMARY = "the faked summary 42";

const startApi = () => {
  const statusCalls = { count: 0 };

  const server = createServer((request, response) => {
    const reply = (status: number, body: Schema.Json) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (request.headers.authorization !== "Bearer machine-token") return reply(401, { ok: false });

    if (request.method === "POST" && request.url === "/api/runs") return reply(202, { ok: true, runId: RUN_ID, contract: { runId: RUN_ID, taskFingerprint: "f", nonce: "n" } });

    if (request.url === `/api/runs/${RUN_ID}/status`) {
      statusCalls.count += 1;
      const terminal = statusCalls.count < 2 ? null : { status: "done", provenance: "this-run", summary: SUMMARY, exitCode: 0, finishedAt: "x" };

      return reply(200, { ok: true, runId: RUN_ID, channel: null, createdAt: "x", status: terminal === null ? "running" : "done", terminal });
    }

    return reply(404, { ok: false });
  });

  return new Promise<{ readonly url: string; readonly close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address()).port}`, close: () => server.close() })));
};

test("MCP server initializes, lists tools and runs a foreground spawn", { timeout: 30_000 }, async () => {
  const api = await startApi();
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "src/client/mcp.ts"], { env: { ...process.env, TERRARIUM_URL: api.url, TERRARIUM_TOKEN: "machine-token" }, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();

  const call = async (id: number, method: string, params: Schema.Json) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const next = await lines.next();

    return JSON.parse(String(next.value));
  };

  const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = await call(2, "tools/list", {});
  assert.deepEqual(listed.result.tools.map((tool: { readonly name: string }) => tool.name).sort(), ["terrarium_cancel", "terrarium_list", "terrarium_loop_start", "terrarium_loop_status", "terrarium_read", "terrarium_spawn", "terrarium_status"]);

  const spawned = await call(3, "tools/call", { name: "terrarium_spawn", arguments: { task: "say hi" } });
  assert.equal(spawned.id, 3);
  assert.notEqual(spawned.result.isError, true);
  assert.match(spawned.result.content[0].text, new RegExp(SUMMARY));
  assert.match(spawned.result.content[0].text, /this-run/);

  child.kill();
  api.close();
});
