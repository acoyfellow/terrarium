import { Duration, Effect, Option, Schema } from "effect";

import { tokensOf } from "./usage.ts";
import type { CallTokens } from "./usage.ts";

export const MODEL_PATH = "/_terrarium_model/v1/chat/completions";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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

type ChatRequest = typeof ChatRequest.Type;

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

interface ModelInput {
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

export const completion = (answer: ModelAnswer, stream: boolean): Response => {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const finishReason = answer.toolCalls.length > 0 ? "tool_calls" : "stop";

  if (!stream) return Response.json({ id, object: "chat.completion", created, model: MODEL, choices: [{ index: 0, message: assistantMessage(answer), finish_reason: finishReason }] });

  const chunk = (delta: StreamDelta, reason: string | null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;

  const body = `${chunk(firstDelta(answer), null)}${chunk({}, finishReason)}data: [DONE]\n\n`;

  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};

export const answerModel = (request: Request, ai: Ai, onTokens: (tokens: CallTokens) => Promise<void> = () => Promise.resolve()): Effect.Effect<Response> =>
  Effect.tryPromise({ try: () => request.json(), catch: () => "body must be JSON" }).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(ChatRequest)(body).pipe(Effect.mapError(() => "invalid messages"))),
    Effect.flatMap((chat) =>
      Effect.tryPromise({ try: () => ai.run(MODEL, modelInput(chat)), catch: () => "model request failed" }).pipe(
        Effect.timed,
        Effect.tap(([duration]) => Effect.logInfo(`terrarium model_ms=${Duration.toMillis(duration)}`)),
        Effect.tap(([, output]) => Option.match(tokensOf(output), { onNone: () => Effect.void, onSome: (tokens) => Effect.ignore(Effect.tryPromise(() => onTokens(tokens))) })),
        Effect.flatMap(([, output]) => Option.match(decodeModelOutput(output), { onNone: () => Effect.fail("unsupported model output"), onSome: (decoded) => Effect.succeed(answerOf(decoded)) })),
        Effect.map((answer) => completion(answer, chat.stream === true)),
        Effect.mapError((message) => modelError(502, message)),
      )),
    Effect.catch((failure) => Effect.succeed(Schema.is(Schema.String)(failure) ? modelError(400, failure) : failure)),
  );

export const isModelRoute = (request: Request, modelHost: string): boolean => {
  const url = new URL(request.url);

  return request.method === "POST" && url.hostname === modelHost && url.pathname === MODEL_PATH;
};

