import { Option, Schema } from "effect";

import type { Identity } from "./identity.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

const ToolArgs = Schema.Record(Schema.String, Schema.Json);

type ToolArgs = typeof ToolArgs.Type;

const RpcMessage = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String), arguments: Schema.optional(ToolArgs) })),
});

type RpcMessage = typeof RpcMessage.Type;

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(RpcMessage));

const decodeText = Schema.decodeUnknownOption(Schema.NonEmptyString);

const decodeInt = Schema.decodeUnknownOption(Schema.Int);

export type OwnerFetch = (request: Request) => Promise<Response>;

const text = { type: "string" };

const tool = (name: string, description: string, properties: Record<string, { readonly type: string }>, required: ReadonlyArray<string>) => ({ name, description, inputSchema: { type: "object", properties, required } });

export const REMOTE_TOOLS = [
  tool("terrarium_spawn", "Run one task in a sealed Terrarium cloud box. Returns the runId right away; poll terrarium_status. Optional proof is a shell command that must exit 0 in /workspace.", { task: text, proof: text, channel: text }, ["task"]),
  tool("terrarium_status", "Status of one run.", { runId: text }, ["runId"]),
  tool("terrarium_read", "Logs of one run.", { runId: text }, ["runId"]),
  tool("terrarium_cancel", "Cancel one run.", { runId: text }, ["runId"]),
  tool("terrarium_list", "List your runs, newest first.", { channel: text, limit: { type: "integer" } }, []),
  tool("terrarium_loop_start", "Start a terraloop that retries a task until it passes. Give proof (a shell command) or expect (text the answer must contain).", { goal: text, task: text, expect: text, proof: text, maxAttempts: { type: "integer" } }, ["goal", "task"]),
  tool("terrarium_loop_status", "One loop by loopId, or all your loops.", { loopId: text }, []),
];

const textArg = (args: ToolArgs, key: string): Option.Option<string> => decodeText(args[key]);

const RUN_ACTIONS = new Map([
  ["terrarium_status", { action: "status", method: "GET" }],
  ["terrarium_read", { action: "logs", method: "GET" }],
  ["terrarium_cancel", { action: "cancel", method: "POST" }],
]);

type RouteBody = Readonly<Record<string, Schema.Json>>;

export function toolRequest(origin: string, name: string, args: ToolArgs): Request | null {
  const json = (method: string, path: string, body?: RouteBody, headers: Record<string, string> = {}) =>
    new Request(new URL(path, origin), { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  const runAction = RUN_ACTIONS.get(name);

  if (runAction !== undefined) {
    return Option.match(textArg(args, "runId"), {
      onNone: () => null,
      onSome: (runId) => json(runAction.method, `/api/runs/${encodeURIComponent(runId)}/${runAction.action}`),
    });
  }

  if (name === "terrarium_spawn") {
    return Option.match(textArg(args, "task"), {
      onNone: () => null,
      onSome: (task) => json("POST", "/api/runs", { task, proof: Option.getOrNull(textArg(args, "proof")), channel: Option.getOrNull(textArg(args, "channel")) }, { "idempotency-key": crypto.randomUUID() }),
    });
  }

  if (name === "terrarium_list") {
    const params = new URLSearchParams();

    Option.map(textArg(args, "channel"), (channel) => params.set("channel", channel));
    Option.map(decodeInt(args.limit), (limit) => params.set("limit", String(limit)));

    return json("GET", `/api/runs?${params}`);
  }

  if (name === "terrarium_loop_start") {
    const ready = Option.isSome(textArg(args, "goal")) && Option.isSome(textArg(args, "task"));

    return ready ? json("POST", "/api/loops", { maxAttempts: 3, ...args }) : null;
  }

  if (name === "terrarium_loop_status") {
    return json("GET", Option.match(textArg(args, "loopId"), { onNone: () => "/api/loops", onSome: (loopId) => `/api/loops/${encodeURIComponent(loopId)}` }));
  }

  return null;
}

type RpcId = RpcMessage["id"];

type RpcResult = Readonly<Record<string, Schema.Json | typeof REMOTE_TOOLS>>;

const rpcResult = (id: RpcId, result: RpcResult) => Response.json({ jsonrpc: "2.0", id: id ?? null, result });

const rpcError = (id: RpcId, code: number, message: string, status = 200) => Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });

async function callTool(origin: string, name: string, args: ToolArgs, ownerFetch: OwnerFetch) {
  const request = toolRequest(origin, name, args);

  if (request === null) return { content: [{ type: "text", text: `invalid arguments for ${name}` }], isError: true };

  const response = await ownerFetch(request);
  const body = await response.text();

  return { content: [{ type: "text", text: body }], isError: !response.ok };
}

async function answer(message: RpcMessage, origin: string, identity: Identity, ownerFetch: OwnerFetch): Promise<Response> {
  if (message.method === "initialize") return rpcResult(message.id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "terrarium", version: "1.0.0" }, instructions: `Signed in as ${identity.email ?? identity.id}.` });

  if (message.method === "ping") return rpcResult(message.id, {});

  if (message.method === "tools/list") return rpcResult(message.id, { tools: REMOTE_TOOLS });

  if (message.method !== "tools/call") return rpcError(message.id, -32601, `method not found: ${message.method ?? ""}`);

  const name = message.params?.name ?? "";

  if (!REMOTE_TOOLS.some((candidate) => candidate.name === name)) return rpcError(message.id, -32602, `unknown tool ${name}`);

  return rpcResult(message.id, await callTool(origin, name, message.params?.arguments ?? {}, ownerFetch));
}

export async function handleMcp(request: Request, identity: Identity, ownerFetch: OwnerFetch): Promise<Response> {
  if (request.method === "DELETE") return new Response(null, { status: 204 });

  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  const decoded = decodeMessage(await request.text());

  if (Option.isNone(decoded)) return rpcError(null, -32700, "parse error", 400);

  const message = decoded.value;

  if (message.id === undefined || message.id === null) return new Response(null, { status: 202 });

  return answer(message, new URL(request.url).origin, identity, ownerFetch);
}
