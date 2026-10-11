import { createInterface } from "node:readline";

import { Effect, Layer, Schema } from "effect";

import { TokenSourceLive } from "./access-token.ts";
import { TerrariumClient, TerrariumClientLive } from "./http.ts";
import type { ClientError, RunView } from "./http.ts";

const PROTOCOL_VERSION = "2025-06-18";

const Request = Schema.Struct({ id: Schema.optional(Schema.Union([Schema.String, Schema.Number])), method: Schema.String, params: Schema.optional(Schema.Json) });

const CallParams = Schema.Struct({ name: Schema.String, arguments: Schema.optional(Schema.Json) });

const RunArgs = Schema.Struct({ runId: Schema.String });

const SpawnArgs = Schema.Struct({ task: Schema.String, channel: Schema.optional(Schema.String), background: Schema.optional(Schema.Boolean) });

const ListArgs = Schema.Struct({ channel: Schema.optional(Schema.String), limit: Schema.optional(Schema.Int) });

const LoopArgs = Schema.Struct({ goal: Schema.String, task: Schema.String, expect: Schema.String, maxAttempts: Schema.optional(Schema.Int) });

const LoopStatusArgs = Schema.Struct({ loopId: Schema.optional(Schema.String) });

const text = { type: "string" };

const tool = (name: string, description: string, properties: Record<string, { readonly type: string }>, required: ReadonlyArray<string>) => ({ name, description, inputSchema: { type: "object", properties, required } });

const tools = [
  tool("terrarium_spawn", "Run one bounded task in a Terrarium cloud sandbox. Foreground waits up to 10 minutes; background returns the runId.", { task: text, channel: text, background: { type: "boolean" } }, ["task"]),
  tool("terrarium_status", "Status of one run.", { runId: text }, ["runId"]),
  tool("terrarium_read", "Logs of one run.", { runId: text }, ["runId"]),
  tool("terrarium_cancel", "Cancel one run.", { runId: text }, ["runId"]),
  tool("terrarium_list", "List your runs, newest first.", { channel: text, limit: { type: "integer" } }, []),
  tool("terrarium_loop_start", "Start a terraloop that retries a task until its answer contains expect.", { goal: text, task: text, expect: text, maxAttempts: { type: "integer" } }, ["goal", "task", "expect"]),
  tool("terrarium_loop_status", "One loop by loopId, or all your loops.", { loopId: text }, []),
];

const POLL_MS = 3000;

const WAIT_MS = 600_000;

const waitForTerminal = (runId: string): Effect.Effect<RunView, ClientError, TerrariumClient> =>
  Effect.flatMap(TerrariumClient, (client) => client.status(runId)).pipe(
    Effect.flatMap((view) => (view.terminal === null ? Effect.sleep(POLL_MS).pipe(Effect.andThen(waitForTerminal(runId))) : Effect.succeed(view))),
  );

const decodeArgs = <S extends Schema.Decoder<unknown>>(schema: S, input: Schema.Json | undefined) => Schema.decodeUnknownEffect(schema)(input ?? {});

const spawn = (input: Schema.Json | undefined) => Effect.gen(function* () {
  const args = yield* decodeArgs(SpawnArgs, input);
  const client = yield* TerrariumClient;
  const admitted = yield* client.spawn(args.task, args.channel);

  if (args.background === true) return { runId: admitted.runId, background: true };

  const view = yield* waitForTerminal(admitted.runId).pipe(Effect.timeout(WAIT_MS));

  return { runId: view.runId, status: view.status, contractStatus: view.terminal?.contractStatus, summary: view.terminal?.summary };
});

const callTool = (name: string, input: Schema.Json | undefined) => Effect.gen(function* () {
  const client = yield* TerrariumClient;

  if (name === "terrarium_spawn") return yield* spawn(input);

  if (name === "terrarium_status") return yield* client.status((yield* decodeArgs(RunArgs, input)).runId);

  if (name === "terrarium_read") return yield* client.logs((yield* decodeArgs(RunArgs, input)).runId);

  if (name === "terrarium_cancel") return yield* client.cancel((yield* decodeArgs(RunArgs, input)).runId);

  if (name === "terrarium_list") return yield* client.list(yield* decodeArgs(ListArgs, input));

  if (name === "terrarium_loop_start") return yield* client.startLoop(yield* decodeArgs(LoopArgs, input));

  if (name === "terrarium_loop_status") {
    const { loopId } = yield* decodeArgs(LoopStatusArgs, input);

    return yield* (loopId === undefined ? client.loops : client.loop(loopId));
  }

  return yield* Effect.fail(new Error(`unknown tool ${name}`));
});

const toolResult = (name: string, input: Schema.Json | undefined) =>
  callTool(name, input).pipe(
    Effect.map((result) => ({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] })),
    Effect.catch((error) => Effect.succeed({ content: [{ type: "text", text: String(error) }], isError: true })),
  );

const resultFor = (method: string, params: Schema.Json | undefined) => Effect.gen(function* () {
  if (method === "initialize") return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "terrarium-effect", version: "0.1.0" } };

  if (method === "tools/list") return { tools };

  if (method === "tools/call") {
    const call = yield* decodeArgs(CallParams, params);

    return yield* toolResult(call.name, call.arguments);
  }

  if (method === "ping") return {};

  return yield* Effect.fail(new Error(`method not found: ${method}`));
});

export const handleLine = (line: string) => Effect.gen(function* () {
  const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Request))(line);

  if (request.id === undefined) return null;

  return yield* resultFor(request.method, request.params).pipe(
    Effect.map((result) => ({ jsonrpc: "2.0", id: request.id, result })),
    Effect.catch((error) => Effect.succeed({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: String(error) } })),
  );
}).pipe(Effect.catch(() => Effect.succeed({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })));

export const clientLayer = (url: string) => TerrariumClientLive(url).pipe(Layer.provide(TokenSourceLive(url, process.env.TERRARIUM_TOKEN)));

export const serveStdio = (url: string) => {
  const layer = clientLayer(url);

  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim().length === 0) return;

    void Effect.runPromise(handleLine(line).pipe(Effect.provide(layer))).then((response) => response === null || process.stdout.write(`${JSON.stringify(response)}\n`));
  });
};

if (import.meta.main) serveStdio(process.env.TERRARIUM_URL ?? "");
