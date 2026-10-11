import { Sandbox as SdkSandbox, getSandbox } from "@cloudflare/sandbox";
import { Context, Effect, Layer, Schema } from "effect";

import { Upstream } from "./shared.ts";
import type { RunContract } from "./shared.ts";

export interface SandboxResult {
  readonly output: string;
  readonly exitCode: number;
}

export class Sandbox extends Context.Service<Sandbox, { readonly run: (task: string, contract: RunContract) => Effect.Effect<SandboxResult, Upstream> }>()("terrarium/Sandbox") {}

export type ModelEnv = Cloudflare.Env & { readonly TERRARIUM_MODEL_HOST: string };

export interface SandboxEnv {
  readonly TERRARIUM_SANDBOX: DurableObjectNamespace<TerrariumSandbox>;
  readonly TERRARIUM_MODEL_HOST: string;
}

export const MODEL_PATH = "/_terrarium_model/v1/chat/completions";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const RUN_TIMEOUT_MS = 600_000;

const Part = Schema.Union([Schema.String, Schema.Struct({ text: Schema.optional(Schema.String) })]);

const Content = Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Part)]));

const ChatRequest = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })).check(Schema.isMinLength(1)),
  stream: Schema.optional(Schema.Boolean),
});

const ModelReply = Schema.Struct({ response: Schema.String });

const isText = Schema.is(Schema.String);

const textOf = (content: typeof Content.Type): string => {
  if (content === null) return "";

  if (isText(content)) return content;

  return content.map((part) => (isText(part) ? part : (part.text ?? ""))).join("");
};

const modelError = (status: number, message: string) => Response.json({ error: { message, type: "terrarium_model_error" } }, { status });

const completion = (content: string, stream: boolean): Response => {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) return Response.json({ id, object: "chat.completion", created, model: MODEL, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

  const chunk = (delta: { readonly role?: string; readonly content?: string }, finishReason: string | null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

  const body = `${chunk({ role: "assistant", content }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;

  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};

export const answerModel = (request: Request, ai: Ai): Effect.Effect<Response> =>
  Effect.tryPromise({ try: () => request.json(), catch: () => "body must be JSON" }).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(ChatRequest)(body).pipe(Effect.mapError(() => "invalid messages"))),
    Effect.flatMap((chat) =>
      Effect.tryPromise({ try: () => ai.run(MODEL, { messages: chat.messages.map((message) => ({ role: message.role, content: textOf(message.content) })) }), catch: () => "model request failed" }).pipe(
        Effect.flatMap((output) => Schema.decodeUnknownEffect(ModelReply)(output).pipe(Effect.mapError(() => "unsupported model output"))),
        Effect.map((reply) => completion(reply.response, chat.stream === true)),
        Effect.mapError((message) => modelError(502, message)),
      )),
    Effect.catch((failure) => Effect.succeed(Schema.is(Schema.String)(failure) ? modelError(400, failure) : failure)),
  );

export const isModelRoute = (request: Request, modelHost: string): boolean => {
  const url = new URL(request.url);

  return request.method === "POST" && url.hostname === modelHost && url.pathname === MODEL_PATH;
};

const outbound = (request: Request, env: ModelEnv): Promise<Response> =>
  isModelRoute(request, env.TERRARIUM_MODEL_HOST) ? Effect.runPromise(answerModel(request, env.AI)) : Promise.resolve(modelError(403, "egress denied"));

export class TerrariumSandbox extends SdkSandbox<ModelEnv> {
  override enableInternet = false;

  override interceptHttps = true;
}

TerrariumSandbox.outbound = outbound;

const containerEnv = (modelHost: string) => ({
  TERRARIUM_MODEL: "terrarium/workers-ai",
  TERRARIUM_MODEL_BASE_URL: `https://${modelHost}/_terrarium_model/v1`,
  TERRARIUM_PI_PROVIDER: "/etc/terrarium/terrarium-provider.mjs",
  NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
});

const sandboxCall = <A>(call: () => Promise<A>) => Effect.tryPromise({ try: call, catch: (cause) => new Upstream({ service: "sandbox", detail: String(cause) }) });

const labelStderr = (stderr: string) => stderr.split("\n").filter((line) => line.length > 0).map((line) => `[stderr] ${line}`).join("\n");

export const sandboxLayer = (env: SandboxEnv) => Layer.succeed(Sandbox, Sandbox.of({
  run: (task, contract) => Effect.gen(function* () {
    const box = getSandbox(env.TERRARIUM_SANDBOX, contract.runId);
    yield* sandboxCall(() => box.writeFile("/workspace/terrarium-task.txt", task));
    yield* sandboxCall(() => box.writeFile("/workspace/terrarium-contract.json", JSON.stringify(contract)));
    const result = yield* sandboxCall(() => box.exec("/usr/local/bin/terrarium-runner", { timeout: RUN_TIMEOUT_MS, env: containerEnv(env.TERRARIUM_MODEL_HOST) }));

    return { output: [result.stdout, labelStderr(result.stderr)].filter((part) => part.length > 0).join("\n"), exitCode: result.exitCode };
  }).pipe(Effect.ensuring(Effect.ignore(sandboxCall(() => getSandbox(env.TERRARIUM_SANDBOX, contract.runId).destroy())))),
}));
