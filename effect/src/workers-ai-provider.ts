import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import { Option } from "effect";
import type { AssistantMessage, Message, Model, TranscriptContext, Tool } from "@earendil-works/pi-ai";

import { answerOf, decodeChatRequest, decodeModelOutput, runModel } from "./model-route.ts";
import type { ModelAnswer } from "./model-route.ts";

export const WORKERS_AI_PROVIDER = "terrarium-workers-ai";

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const API = "terrarium-workers-ai";

interface OpenAiMessage {
  readonly role: string;
  readonly content: string;
  readonly tool_calls?: ReadonlyArray<{ readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }>;
  readonly tool_call_id?: string;
}

const textOf = (content: Message["content"]): string => {
  if (!Array.isArray(content)) return String(content);

  return content.flatMap((block) => ("text" in block && block.type === "text" ? [block.text] : [])).join("\n");
};

const systemText = (message: Extract<Message, { role: "system" }>): string => {
  const sections = Object.values(message.sections ?? {}).filter((section): section is string => section !== null);

  return [textOf(message.content), ...sections].filter((part) => part.length > 0).join("\n\n");
};

export const toOpenAi = (messages: ReadonlyArray<Message>): ReadonlyArray<OpenAiMessage> =>
  messages.map((message): OpenAiMessage => {
    if (message.role === "system") return { role: "system", content: systemText(message) };

    if (message.role === "user") return { role: "user", content: textOf(message.content) };

    if (message.role === "toolResult") return { role: "tool", content: textOf(message.content), tool_call_id: message.toolCallId };

    const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [{ id: block.id, type: "function" as const, function: { name: block.name, arguments: JSON.stringify(block.arguments) } }] : []));
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

    return calls.length > 0 ? { role: "assistant", content: text, tool_calls: calls } : { role: "assistant", content: text };
  });

const toolsOf = (messages: ReadonlyArray<Message>): ReadonlyArray<Tool> =>
  messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []));

const flatParameters = (tool: Tool) => {
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, { type: JSON.parse(JSON.stringify(value)).type ?? "string", description: JSON.parse(JSON.stringify(value)).description ?? "" }]));

  return { type: "object", required: schema.required ?? [], properties };
};

export const assistantFrom = (answer: ModelAnswer, modelId: string): AssistantMessage => ({
  role: "assistant",
  api: API,
  provider: WORKERS_AI_PROVIDER,
  model: modelId,
  content: [
    ...(answer.content.length > 0 ? [{ type: "text" as const, text: answer.content }] : []),
    ...answer.toolCalls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments.length > 0 ? call.function.arguments : "{}") })),
  ],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: answer.toolCalls.length > 0 ? "toolUse" : "stop",
  timestamp: Date.now(),
});

const failed = (message: string, modelId: string): AssistantMessage => ({ ...assistantFrom({ content: "", toolCalls: [] }, modelId), stopReason: "error", errorMessage: message });

export const workersAiProvider = (ai: Ai) => {
  const stream = (model: Model<typeof API>, context: TranscriptContext) => {
    const out = createAssistantMessageEventStream();
    const tools = toolsOf(context.messages).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: flatParameters(tool) } }));
    const chat = decodeChatRequest(tools.length > 0 ? { messages: toOpenAi(context.messages), tools } : { messages: toOpenAi(context.messages) });

    const call = Option.match(chat, { onNone: () => Promise.reject(new Error("could not build a model request")), onSome: (request) => runModel(ai, request) });

    call.then(
      (output) => {
        const decoded = decodeModelOutput(output);
        const message = Option.match(decoded, { onNone: () => failed("unsupported model output", model.id), onSome: (value) => assistantFrom(answerOf(value), model.id) });

        out.push({ type: "start", partial: message });
        out.push(message.stopReason === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
        out.end(message);
      },
      (cause) => {
        const message = failed(String(cause), model.id);

        out.push({ type: "error", reason: "error", error: message });
        out.end(message);
      },
    );

    return out;
  };

  return createProvider({
    id: WORKERS_AI_PROVIDER,
    auth: { apiKey: { name: "Workers AI binding", resolve: () => Promise.resolve({ auth: {} }) } },
    models: [{ id: WORKERS_AI_MODEL, name: "Llama 3.3 70B (Workers AI)", api: API, provider: WORKERS_AI_PROVIDER, baseUrl: "binding:AI", reasoning: false, input: ["text"], cost: { input: 0.29, output: 2.25, cacheRead: 0, cacheWrite: 0 }, contextWindow: 24_000, maxTokens: 4096 }],
    api: { stream, streamSimple: stream },
  });
};
