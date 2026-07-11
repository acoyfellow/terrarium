// Model catalog / policy engine (Gate 5 minimal slice).
//
// PURE functions only — no network, no live inference, no secrets. This is the
// advisory catalog + policy layer proven in experiments/model-routing-ax. It is
// ADDITIVE: it does NOT change how handleWorkersAiEgress selects the server
// model (that path remains server-owned and byte-identical). It powers a
// read-only GET /api/models view and provides the fail-closed selection logic
// a future broker extension can adopt.
//
// Trust rule: `sources` is TRUSTED deployment config. Any `pin`/`clientBody`
// from a request is UNTRUSTED. The engine only MATCHES untrusted input against
// a server-computed effective catalog; it never uses untrusted input to build
// the catalog, a URL, a header, or a credential.

const WORKERS_AI_DEFAULT = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Curated Workers AI catalog with measured capability metadata. Upstream model
// strings are server-side only and MUST NOT be surfaced to clients/receipts.
// This mirrors the existing ALLOWED_WORKERS_AI_MODELS set (no behavior change);
// aliases are the safe, opaque names the product exposes.
const WORKERS_AI_MODELS = [
  { alias: "workers-ai/llama-3.3-70b", upstreamModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    capabilities: { reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 } },
  { alias: "workers-ai/llama-3.1-8b-fast", upstreamModel: "@cf/meta/llama-3.1-8b-instruct-fast",
    capabilities: { reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 } },
  { alias: "workers-ai/llama-3.1-8b", upstreamModel: "@cf/meta/llama-3.1-8b-instruct",
    capabilities: { reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 } },
];

/**
 * Build the TRUSTED source registry from deployment config. Today only the
 * built-in Workers AI source is seeded (byte-identical to current behavior).
 * Custom sources are intentionally NOT read from env here; they require an
 * explicit server-side source-registration design and private bindings, and
 * must never be constructed from request input. Returns { sources, defaultAlias }.
 */
export function buildSourceRegistry(env = {}) {
  const sources = {
    "workers-ai": {
      adapter: "workers-ai",
      binding: "AI",
      models: WORKERS_AI_MODELS,
    },
  };
  // Optional custom sources come ONLY from server-side deployment config
  // (env.TERRARIUM_CUSTOM_SOURCES, a JSON string set as a private Wrangler var).
  // Public source contains none of the real values; the endpoint and credential
  // are referenced indirectly by env-key NAMES (endpointEnv/tokenEnv) resolved
  // server-side. Parsing is fail-closed: a malformed entry is dropped, never
  // widened. Nothing here is ever built from request input.
  mergeCustomSources(sources, env);
  // The deployment default alias mirrors resolveServerModel(env): if the env
  // pins an allowlisted upstream model, reflect it; else the default llama.
  const envModel = typeof env.TERRARIUM_WORKERS_AI_MODEL === "string" ? env.TERRARIUM_WORKERS_AI_MODEL : "";
  const match = WORKERS_AI_MODELS.find((m) => m.upstreamModel === envModel);
  const defaultAlias = match ? match.alias : "workers-ai/llama-3.3-70b";
  return { sources, defaultAlias, defaultUpstream: match ? match.upstreamModel : WORKERS_AI_DEFAULT };
}

export function aliasOf(sourceId, name) {
  return `${sourceId}/${name}`;
}

/**
 * Merge operator-configured custom sources from env.TERRARIUM_CUSTOM_SOURCES.
 * Shape (all TRUSTED deployment config, placeholders in public tests):
 *   [{ sourceId, adapter:"openai-compatible", endpointEnv, tokenEnv,
 *      models:[{alias, upstreamModel, capabilities}], policy? }]
 * endpointEnv/tokenEnv name the env keys that hold the real endpoint/secret;
 * the values themselves are never in source. Fail-closed on any malformed entry.
 */
function mergeCustomSources(sources, env) {
  const raw = env?.TERRARIUM_CUSTOM_SOURCES;
  if (typeof raw !== "string" || raw.length === 0) return;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(parsed)) return;
  for (const s of parsed) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.sourceId !== "string" || !s.sourceId || s.sourceId === "workers-ai") continue;
    if (s.adapter !== "openai-compatible") continue;
    if (typeof s.endpointEnv !== "string" || typeof s.tokenEnv !== "string") continue;
    if (!Array.isArray(s.models) || s.models.length === 0) continue;
    const models = s.models.filter((m) => m && typeof m.alias === "string" && typeof m.upstreamModel === "string");
    if (models.length === 0) continue;
    sources[s.sourceId] = {
      adapter: "openai-compatible",
      endpointEnv: s.endpointEnv,
      tokenEnv: s.tokenEnv,
      binding: s.tokenEnv,
      models: models.map((m) => ({ alias: m.alias, upstreamModel: m.upstreamModel, capabilities: m.capabilities || {} })),
      ...(s.policy && typeof s.policy === "object" ? { policy: s.policy } : {}),
    };
  }
}

/** Intersect allowed sources across scopes; a scope may only NARROW. */
export function effectiveSources(sources, scopes = {}) {
  const all = Object.keys(sources);
  let allowed = new Set(all);
  for (const level of ["deployment", "workspace", "user", "run"]) {
    const cfg = scopes[level];
    if (cfg && Array.isArray(cfg.allowSources)) {
      allowed = new Set([...allowed].filter((s) => cfg.allowSources.includes(s)));
    }
  }
  const principal = scopes.principal;
  return all.filter((sid) => {
    if (!allowed.has(sid)) return false;
    const pol = sources[sid].policy;
    if (pol && Array.isArray(pol.allowPrincipals)) return pol.allowPrincipals.includes(principal);
    return true;
  });
}

/** Caller's effective catalog: safe fields + status. Never upstream/secret. */
export function effectiveCatalog(sources, scopes = {}, health = {}) {
  const out = [];
  for (const sid of effectiveSources(sources, scopes)) {
    const models = (sources[sid].models || []).map((m) => ({
      alias: m.alias,
      capabilities: m.capabilities || {},
      status: health[m.alias] === "unavailable" ? "unavailable" : "available",
    }));
    out.push({ sourceId: sid, models });
  }
  return out;
}

function catalogIndex(catalog) {
  const idx = new Map();
  for (const s of catalog) for (const m of s.models) {
    if (idx.has(m.alias)) idx.set(m.alias, "AMBIGUOUS");
    else idx.set(m.alias, { sourceId: s.sourceId, status: m.status });
  }
  return idx;
}

/** Resolve a pin; any ambiguity/miss resolves to the NARROWER outcome. */
export function resolveSelection(pin, catalog, { defaultAlias } = {}) {
  const idx = catalogIndex(catalog);
  if (pin == null || pin === "") {
    if (defaultAlias && idx.get(defaultAlias) && idx.get(defaultAlias) !== "AMBIGUOUS") {
      return { decision: "default", alias: defaultAlias, sourceId: idx.get(defaultAlias).sourceId, reason: "effective default", receiptReason: "default" };
    }
    return { decision: "default", alias: defaultAlias || null, sourceId: null, reason: "deployment default", receiptReason: "default" };
  }
  if (typeof pin !== "string") return { decision: "unknown", reason: "pin is not a string", http: 400, receiptReason: "model-unknown" };
  const hit = idx.get(pin);
  if (!hit) return { decision: "unknown", reason: "alias not in effective catalog", http: 400, receiptReason: "model-unknown" };
  if (hit === "AMBIGUOUS") return { decision: "unknown", reason: "alias maps to more than one source", http: 400, receiptReason: "model-unknown" };
  if (hit.status === "unavailable") return { decision: "unavailable", alias: pin, sourceId: hit.sourceId, reason: "source at capacity/unhealthy", http: 429, receiptReason: "model-backpressure" };
  return { decision: "allowed", alias: pin, sourceId: hit.sourceId, reason: "authorized pin", receiptReason: "allowed" };
}

/** Denied(403) vs unknown(400) for the API layer, which can see full config. */
export function classifyMiss(pin, sources, catalog) {
  if (catalogIndex(catalog).has(pin)) return null;
  let defined = false;
  for (const sid of Object.keys(sources)) {
    if ((sources[sid].models || []).some((m) => m.alias === pin)) { defined = true; break; }
  }
  return defined
    ? { decision: "denied", reason: "alias exists but not authorized for principal/scope", http: 403, receiptReason: "model-denied" }
    : { decision: "unknown", reason: "alias not defined in any source", http: 400, receiptReason: "model-unknown" };
}

/**
 * Classify a provider outcome. Workers AI 3021 backpressure is its OWN class
 * and MUST NOT be retried or fanned out — distinct from transient 5xx (retry
 * ok) and output-error (model ran, no usable output).
 */
export function classifyProviderOutcome(outcome = {}) {
  const code = outcome.code != null ? String(outcome.code) : "";
  const status = Number(outcome.status);
  const msg = String(outcome.message || "");
  if (code === "3021" || /\b3021\b/.test(msg) || outcome.kind === "backpressure") {
    return { class: "rate-limited", retryable: false, fanOutAllowed: false, http: 429, receiptReason: "model-backpressure" };
  }
  if (outcome.kind === "output-error") return { class: "output-error", retryable: false, fanOutAllowed: false, http: 200, receiptReason: "receipt-missing" };
  if (outcome.kind === "deadline" || status === 504) return { class: "deadline", retryable: false, fanOutAllowed: false, http: 504, receiptReason: "model-deadline" };
  if (Number.isInteger(status) && status >= 500) return { class: "provider-error", retryable: true, fanOutAllowed: true, http: 502, receiptReason: "model-provider-failed" };
  if (Number.isInteger(status) && status >= 400) return { class: "provider-error", retryable: false, fanOutAllowed: true, http: 502, receiptReason: "model-provider-failed" };
  return { class: "ok", retryable: false, fanOutAllowed: true, http: 200, receiptReason: "ok" };
}

/** SAFE receipt fields only — never upstream model, endpoint, or credential. */
export function safeReceiptFields(resolved) {
  return { source: resolved.sourceId || null, model: resolved.alias || null, policy: resolved.receiptReason || resolved.decision };
}

/**
 * Broker-side enforcement resolver. Given an OPAQUE alias that arrived through
 * the (untrusted) cell request, re-validate it against the SERVER-OWNED source
 * registry and return the upstream model + binding to route to. This is the
 * enforcement point: the alias is only ever MATCHED against server config; it
 * is never used to build a URL/credential, and any unknown/ambiguous/absent
 * alias falls back to the deployment default (fail-closed — a bad alias can
 * never route to an unlisted upstream). Returns:
 *   { upstreamModel, binding, alias, sourceId, matched }
 * `matched` is false when the fallback default was used.
 */
export function resolveUpstreamForBroker(alias, env = {}) {
  const { sources, defaultAlias, defaultUpstream } = buildSourceRegistry(env);
  const fallback = { upstreamModel: defaultUpstream, binding: "AI", adapter: "workers-ai", alias: defaultAlias, sourceId: "workers-ai", matched: false };
  if (typeof alias !== "string" || alias === "") return fallback;
  // Exact match across all server sources; ambiguity => fallback (never guess).
  let hit = null;
  for (const sid of Object.keys(sources)) {
    for (const m of sources[sid].models || []) {
      if (m.alias === alias) {
        if (hit) return fallback; // ambiguous
        const src = sources[sid];
        hit = {
          upstreamModel: m.upstreamModel, binding: src.binding, adapter: src.adapter,
          alias: m.alias, sourceId: sid, matched: true,
          ...(src.endpointEnv ? { endpointEnv: src.endpointEnv, tokenEnv: src.tokenEnv } : {}),
        };
      }
    }
  }
  return hit || fallback;
}

/**
 * Generic openai-compatible custom-router adapter. Runs SERVER-SIDE in the
 * broker. Endpoint + token are resolved from env by the NAMES carried in the
 * resolved source (never from request input, never literals in source). The
 * cell/client never sees the endpoint or token. Returns a normalized-ish
 * completion object (the broker normalizes further). `fetchImpl` is injectable
 * for deterministic tests; defaults to global fetch.
 */
export async function routeOpenAICompatible(resolved, input, env, { fetchImpl = fetch, deadlineMs = 30000 } = {}) {
  const endpoint = env?.[resolved.endpointEnv];
  const token = env?.[resolved.tokenEnv];
  if (typeof endpoint !== "string" || !endpoint) throw Object.assign(new Error("custom source endpoint unavailable"), { status: 503 });
  if (typeof token !== "string" || !token) throw Object.assign(new Error("custom source credential unavailable"), { status: 503 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: resolved.upstreamModel, ...input }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw Object.assign(new Error("custom provider failed"), { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
