import { Duration, Effect, Option, Schema } from "effect";

import { DEFAULT_MODEL, routeOf } from "./models.ts";
import type { ModelRoute } from "./models.ts";
import { tokensOf } from "./usage.ts";
import type { CallTokens } from "./usage.ts";

export const MODEL_PATH = "/_terrarium_model/v1/chat/completions";

const Part = Schema.Union([Schema.String, Schema.Struct({ text: Schema.optional(Schema.String) })]);

const Content = Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Part)]));

const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

type ToolCall = typeof ToolCall.Type;

const Message = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Content),
  tool_calls: Schema.optional(Schema.Array(ToolCall)),
  tool_call_id: Schema.optional(Schema.String),
});

const Parameters = Schema.Struct({
  type: Schema.String,
  required: Schema.optional(Schema.Array(Schema.String)),
  properties: Schema.Record(Schema.String, Schema.Struct({ type: Schema.optional(Schema.String), description: Schema.optional(Schema.String) })),
});

const ToolSpec = Schema.Struct({
  type: Schema.String,
  function: Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String), parameters: Parameters }),
});

const ChatRequest = Schema.Struct({
  messages: Schema.Array(Message).check(Schema.isMinLength(1)),
  tools: Schema.optional(Schema.Array(ToolSpec)),
  stream: Schema.optional(Schema.Boolean),
});

export type ChatRequest = typeof ChatRequest.Type;

export const decodeChatRequest = Schema.decodeUnknownOption(ChatRequest);

// Where a box's model calls go. The box only ever sees the Terrarium model route;
// the Worker picks the backend from the model recorded for the run. Each backend
// parses its reply at the boundary, so callers get an answer and token counts.
export interface ModelReply {
  readonly answer: ModelAnswer;
  readonly tokens: Option.Option<CallTokens>;
}

export interface ModelBackend {
  readonly id: string;
  readonly run: (input: ModelInput) => Promise<ModelReply>;
}

const replyOf = (output: ReturnType<typeof JSON.parse>): Promise<ModelReply> =>
  Option.match(decodeModelOutput(output), {
    onNone: () => Promise.reject(new Error("unsupported model output")),
    onSome: (decoded) => Promise.resolve({ answer: answerOf(decoded), tokens: tokensOf(output) }),
  });

// routeOf only admits @cf/ and @hf/ catalog ids; Workers AI itself rejects an id it does not serve.
const isCatalogModel = (id: string): id is Extract<keyof AiModels, string> => Option.isSome(routeOf(id)) && id.startsWith("@");

export const workersAiBackend = (ai: Ai, id: string = DEFAULT_MODEL): ModelBackend => ({
  id,
  run: (input) => (isCatalogModel(id) ? ai.run(id, input).then(replyOf) : Promise.reject(new Error(`${id} is not a Workers AI model`))),
});

// AI Gateway's OpenAI-compatible unified endpoint, for example
// https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat. Provider keys
// live in the gateway (stored keys); the Worker holds only the gateway token.
export interface GatewayConfig {
  readonly url: string;
  readonly token: string;
}

export interface GatewayEnv {
  readonly TERRARIUM_GATEWAY_URL?: string;
  readonly TERRARIUM_GATEWAY_TOKEN?: string;
}

// Both values are needed; either one alone means no gateway.
export const gatewayOf = (env: GatewayEnv): GatewayConfig | null => {
  const url = env.TERRARIUM_GATEWAY_URL?.trim() ?? "";
  const token = env.TERRARIUM_GATEWAY_TOKEN?.trim() ?? "";

  return url.startsWith("https://") && token.length > 0 ? { url, token } : null;
};

const GATEWAY_ERROR_CHARS = 300;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const globalFetch: Fetcher = (url, init) => fetch(url, init);

export const gatewayBackend = (config: GatewayConfig, id: string, fetcher: Fetcher = globalFetch): ModelBackend => ({
  id,
  run: (input) =>
    fetcher(`${config.url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-aig-authorization": `Bearer ${config.token}` },
      body: JSON.stringify({ model: id, ...input, stream: false }),
    }).then((response) => (response.ok ? response.json().then(replyOf) : response.text().then((body) => Promise.reject(new Error(`gateway ${response.status}: ${body.slice(0, GATEWAY_ERROR_CHARS)}`))))),
});

const unavailable = (id: string, reason: string): ModelBackend => ({ id, run: () => Promise.reject(new Error(reason)) });

export interface Backends {
  readonly workersAi: (id: string) => ModelBackend;
  readonly gateway: GatewayConfig | null;
  readonly fetcher?: Fetcher;
}

export const backendFor = (route: ModelRoute, backends: Backends): ModelBackend => {
  if (route.kind === "workers-ai") return backends.workersAi(route.id);

  return backends.gateway === null ? unavailable(route.id, `${route.id} needs AI Gateway, and this Terrarium has no TERRARIUM_GATEWAY_URL and TERRARIUM_GATEWAY_TOKEN`) : gatewayBackend(backends.gateway, route.id, backends.fetcher);
};

export const runModel = (ai: Ai, chat: ChatRequest): Promise<ModelReply> => workersAiBackend(ai).run(modelInput(chat));

const LegacyReply = Schema.Struct({ response: Schema.String });

const ChoiceReply = Schema.Struct({
  choices: Schema.NonEmptyArray(Schema.Struct({
    message: Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)), tool_calls: Schema.optional(Schema.NullOr(Schema.Array(ToolCall))) }),
  })),
});

export interface ModelAnswer {
  readonly content: string;
  readonly toolCalls: ReadonlyArray<ToolCall>;
}

const isText = Schema.is(Schema.String);

const textOf = (content: typeof Content.Type | undefined): string => {
  if (content === null || content === undefined) return "";

  if (isText(content)) return content;

  return content.map((part) => (isText(part) ? part : (part.text ?? ""))).join("");
};

const toolFor = (spec: typeof ToolSpec.Type) => ({
  type: spec.type,
  function: {
    name: spec.function.name,
    description: spec.function.description ?? "",
    parameters: {
      type: spec.function.parameters.type,
      required: [...(spec.function.parameters.required ?? [])],
      properties: Object.fromEntries(Object.entries(spec.function.parameters.properties).map(([key, value]) => [key, { type: value.type ?? "string", description: value.description ?? "" }])),
    },
  },
});

interface ModelMessage {
  role: string;
  content: string;
  tool_calls?: Array<ToolCall>;
  tool_call_id?: string;
}

export interface ModelInput {
  messages: Array<ModelMessage>;
  tools?: Array<ReturnType<typeof toolFor>>;
}

const modelMessage = (message: typeof Message.Type): ModelMessage => {
  const forwarded: ModelMessage = { role: message.role, content: textOf(message.content) };

  if (message.tool_calls !== undefined) forwarded.tool_calls = [...message.tool_calls];

  if (message.tool_call_id !== undefined) forwarded.tool_call_id = message.tool_call_id;

  return forwarded;
};

export const modelInput = (chat: ChatRequest): ModelInput => {
  const input: ModelInput = { messages: chat.messages.map(modelMessage) };

  if (chat.tools !== undefined && chat.tools.length > 0) input.tools = chat.tools.map(toolFor);

  return input;
};

const ModelOutput = Schema.Union([ChoiceReply, LegacyReply]);

export type ModelOutput = typeof ModelOutput.Type;

export const decodeModelOutput = Schema.decodeUnknownOption(ModelOutput);

export const answerOf = (output: ModelOutput): ModelAnswer => {
  if ("choices" in output) {
    const message = output.choices[0].message;

    return { content: message.content ?? "", toolCalls: message.tool_calls ?? [] };
  }

  return { content: output.response, toolCalls: [] };
};

export const modelError = (status: number, message: string) => Response.json({ error: { message, type: "terrarium_model_error" } }, { status });

interface AssistantMessage {
  role: "assistant";
  content: string;
  tool_calls?: ReadonlyArray<ToolCall>;
}

interface StreamDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: ReadonlyArray<ToolCall & { readonly index: number }>;
}

const assistantMessage = (answer: ModelAnswer): AssistantMessage => {
  const message: AssistantMessage = { role: "assistant", content: answer.content };

  if (answer.toolCalls.length > 0) message.tool_calls = answer.toolCalls;

  return message;
};

const firstDelta = (answer: ModelAnswer): StreamDelta => {
  const delta: StreamDelta = { role: "assistant", content: answer.content };

  if (answer.toolCalls.length > 0) delta.tool_calls = answer.toolCalls.map((call, index) => ({ index, ...call }));

  return delta;
};

export const completion = (answer: ModelAnswer, stream: boolean, model: string = DEFAULT_MODEL): Response => {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const finishReason = answer.toolCalls.length > 0 ? "tool_calls" : "stop";

  if (!stream) return Response.json({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: assistantMessage(answer), finish_reason: finishReason }] });

  const chunk = (delta: StreamDelta, reason: string | null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;

  const body = `${chunk(firstDelta(answer), null)}${chunk({}, finishReason)}data: [DONE]\n\n`;

  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};

export const answerModel = (request: Request, backend: ModelBackend, onTokens: (tokens: CallTokens) => Promise<void> = () => Promise.resolve(), onAnswer: (answer: ModelAnswer) => Promise<void> = () => Promise.resolve()): Effect.Effect<Response> =>
  Effect.tryPromise({ try: () => request.json(), catch: () => "body must be JSON" }).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(ChatRequest)(body).pipe(Effect.mapError(() => "invalid messages"))),
    Effect.flatMap((chat) =>
      Effect.tryPromise({ try: () => backend.run(modelInput(chat)), catch: (cause) => `model request failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 400) }).pipe(
        Effect.timed,
        Effect.tap(([duration]) => Effect.logInfo(`terrarium model=${backend.id} model_ms=${Duration.toMillis(duration)}`)),
        Effect.tap(([, reply]) => Option.match(reply.tokens, { onNone: () => Effect.void, onSome: (tokens) => Effect.ignore(Effect.tryPromise(() => onTokens(tokens))) })),
        Effect.map(([, reply]) => reply.answer),
        Effect.tap((answer) => Effect.ignore(Effect.tryPromise(() => onAnswer(answer)))),
        Effect.map((answer) => completion(answer, chat.stream === true, backend.id)),
        Effect.mapError((message) => modelError(502, message)),
      )),
    Effect.catch((failure) => Effect.succeed(Schema.is(Schema.String)(failure) ? modelError(400, failure) : failure)),
  );

export const isModelRoute = (request: Request, modelHost: string): boolean => {
  const url = new URL(request.url);

  return request.method === "POST" && url.hostname === modelHost && url.pathname === MODEL_PATH;
};

