// Production Sandbox DO and credentialless model-egress broker.
// Local declarations/tests are not proof that Cloudflare's live container
// substrate applies interception; deployment requires an explicit runtime probe.

const MODEL_HOST = "terrarium.coey.dev";
const MODEL_PATH = "/_terrarium_model/v1/chat/completions";
const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_MESSAGES = 128;
const MODEL_DEADLINE_MS = 30_000;
// Workers AI occasionally returns a transient 5xx / AiError for a request that
// succeeds on immediate retry. Retry a bounded number of times with short
// backoff, all inside the single MODEL_DEADLINE_MS budget, so a flaky upstream
// does not turn a valid task into a receipt-missing failure. Non-transient
// errors (4xx-class, oversize, unsupported output) are not retried.
const MODEL_MAX_ATTEMPTS = 3;
const MODEL_RETRY_BASE_MS = 400;
const encoder = new TextEncoder();

function isTransientModelError(error) {
  // AiError and generic upstream 5xx are transient; explicit <500 status is not.
  const status = Number(error?.status);
  if (Number.isInteger(status)) return status >= 500;
  const name = String(error?.name || "");
  const msg = String(error?.message || "");
  return /AiError/i.test(name) || /\b5\d{2}\b|capacity|timeout|temporarily|unavailable/i.test(msg);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export const SANDBOX_RUNTIME_CONFIG = Object.freeze({
  enableInternet: false,
  interceptHttps: true,
  allowedHosts: Object.freeze([MODEL_HOST]),
  envVars: Object.freeze({
    TERRARIUM_MODEL: "terrarium/workers-ai",
    // Pi execution cell config. The provider extension reads
    // TERRARIUM_MODEL_BASE_URL; it points at the intercepted server-owned
    // route. Interception keys on this outbound host, independent of the
    // Worker's own ingress hostname, so a workers.dev deploy intercepts the
    // same route as production.
    TERRARIUM_MODEL_BASE_URL: `https://${MODEL_HOST}/_terrarium_model/v1`,
    TERRARIUM_PI_PROVIDER: "/etc/terrarium/terrarium-provider.mjs",
    NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  }),
});

function jsonError(status, error) {
  return Response.json({ error: { message: error, type: "terrarium_model_error" } }, { status });
}

async function readBoundedJson(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error("request too large"), { status: 413 });
  }
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw Object.assign(new Error("request too large"), { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}

// Workers AI chat models require each message `content` to be a plain string.
// Pi's OpenAI-compatible client sends content either as a string, as null, or
// as an array of structured parts (e.g. [{ type: "text", text: "..." }]).
// Normalize all of these to a string so env.AI.run does not reject the request
// with AiError 5006 (schema oneOf mismatch). Unknown non-text parts are dropped
// rather than stringified so tool/image parts never leak as noise text.
function normalizeMessageContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

function boundedAiInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("invalid request"), { status: 400 });
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > MAX_MESSAGES) {
    throw Object.assign(new Error("invalid messages"), { status: 400 });
  }
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || typeof message.role !== "string" || !("content" in message)) {
      throw Object.assign(new Error("invalid messages"), { status: 400 });
    }
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 64)) {
    throw Object.assign(new Error("invalid tools"), { status: 400 });
  }
  const input = {
    messages: body.messages.map((message) => ({
      role: message.role,
      content: normalizeMessageContent(message.content),
      ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
    })),
    max_tokens: Math.min(Math.max(Number(body.max_tokens) || 1024, 1), 4096),
  };
  if (body.temperature !== undefined) input.temperature = Math.min(Math.max(Number(body.temperature) || 0, 0), 2);
  if (body.tools !== undefined) input.tools = body.tools;
  if (body.tool_choice !== undefined) input.tool_choice = body.tool_choice;
  if (body.response_format !== undefined) input.response_format = body.response_format;
  return input;
}

function normalizeCompletion(result) {
  if (result && Array.isArray(result.choices) && result.choices.length > 0) {
    return {
      id: typeof result.id === "string" ? result.id : "chatcmpl-terrarium",
      object: "chat.completion",
      created: Number.isInteger(result.created) ? result.created : Math.floor(Date.now() / 1000),
      model: WORKERS_AI_MODEL,
      choices: result.choices,
      ...(result.usage && typeof result.usage === "object" ? { usage: result.usage } : {}),
    };
  }
  // Workers AI llama returns { response: string, tool_calls?: [...] }. Accept a
  // string response even when empty, and surface any top-level tool_calls, so a
  // valid-but-terse model turn is not misclassified as unsupported output.
  if (result && (typeof result.response === "string" || Array.isArray(result.tool_calls))) {
    const message = { role: "assistant", content: typeof result.response === "string" ? result.response : "" };
    if (Array.isArray(result.tool_calls) && result.tool_calls.length > 0) {
      message.tool_calls = result.tool_calls.map((tc, i) => ({
        id: tc.id || `call_${i}`,
        type: "function",
        function: {
          name: tc.name || tc.function?.name || "",
          arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? tc.function?.arguments ?? {}),
        },
      }));
    }
    return {
      id: "chatcmpl-terrarium",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: WORKERS_AI_MODEL,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    };
  }
  try { console.error(`[terrarium:model] unsupported output keys=${result && typeof result === "object" ? Object.keys(result).join(",") : typeof result}`); } catch { /* ignore */ }
  throw new Error("unsupported model output");
}

function boundedJsonResponse(completion) {
  const text = JSON.stringify(completion);
  if (encoder.encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("model output too large");
  return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
}

function boundedSseResponse(completion) {
  const choice = completion.choices[0] || {};
  const message = choice.message || choice.delta || {};
  const first = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: WORKERS_AI_MODEL,
    choices: [{
      index: Number.isInteger(choice.index) ? choice.index : 0,
      delta: {
        role: message.role || "assistant",
        ...(message.content !== undefined ? { content: message.content } : {}),
        ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls } : {}),
      },
      finish_reason: null,
    }],
  };
  const last = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: WORKERS_AI_MODEL,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
  };
  const text = `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
  if (encoder.encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("model output too large");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

export async function handleWorkersAiEgress(request, env) {
  const url = new URL(request.url);
  if (url.hostname !== MODEL_HOST || url.pathname !== MODEL_PATH) return jsonError(404, "not found");
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  if (!env?.AI || typeof env.AI.run !== "function") return jsonError(503, "model binding unavailable");
  try {
    const body = await readBoundedJson(request);
    const input = boundedAiInput(body);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("model deadline exceeded"), { status: 504 })), MODEL_DEADLINE_MS);
    });
    let result;
    try {
      // Model selection is server-owned. Client body.model and authorization
      // headers are deliberately ignored; the child has no reusable secret.
      // Bounded retry for transient upstream failures, within the deadline.
      let lastError;
      for (let attempt = 1; attempt <= MODEL_MAX_ATTEMPTS; attempt++) {
        try {
          result = await Promise.race([env.AI.run(WORKERS_AI_MODEL, input), timeout]);
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt >= MODEL_MAX_ATTEMPTS || !isTransientModelError(err)) throw err;
          try { console.error(`[terrarium:model] transient attempt ${attempt}/${MODEL_MAX_ATTEMPTS} name=${err?.name || ""} msg=${String(err?.message || err).slice(0, 200)}`); } catch { /* ignore */ }
          await Promise.race([sleep(MODEL_RETRY_BASE_MS * attempt), timeout]);
        }
      }
      if (lastError) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    const completion = normalizeCompletion(result);
    return body.stream === true ? boundedSseResponse(completion) : boundedJsonResponse(completion);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502;
    // Bounded server-side diagnostic. Never returned to the cell; only visible
    // in Worker tail. Helps distinguish AI binding errors from deadline/oversize.
    try { console.error(`[terrarium:model] egress failure status=${status} name=${error?.name || ""} msg=${String(error?.message || error).slice(0, 300)}`); } catch { /* ignore */ }
    return jsonError(status, status < 500 ? error.message : "model request failed");
  }
}

export function denyAllEgress() {
  return jsonError(403, "egress denied");
}

let Base;
try {
  ({ Sandbox: Base } = await import("@cloudflare/sandbox"));
} catch {
  Base = null;
}

class MissingSandboxSdk {
  constructor() {
    throw new Error("TerrariumSandbox requires @cloudflare/sandbox to be installed");
  }
}

export class TerrariumSandbox extends (Base || MissingSandboxSdk) {
  defaultPort = 3000;
  sleepAfter = "10m";
  enableInternet = SANDBOX_RUNTIME_CONFIG.enableInternet;
  interceptHttps = SANDBOX_RUNTIME_CONFIG.interceptHttps;
  allowedHosts = [...SANDBOX_RUNTIME_CONFIG.allowedHosts];
  envVars = { ...SANDBOX_RUNTIME_CONFIG.envVars };

}

// Assign after class definition so the inherited Container static setters run.
// Native class-field semantics define own properties and bypass inherited
// setters, leaving ContainerProxy's class-name registry empty in Workers.
TerrariumSandbox.outboundByHost = { [MODEL_HOST]: handleWorkersAiEgress };
TerrariumSandbox.outbound = denyAllEgress;

export const _testables = {
  MODEL_HOST,
  MODEL_PATH,
  WORKERS_AI_MODEL,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_MESSAGES,
  MODEL_DEADLINE_MS,
  normalizeCompletion,
};
