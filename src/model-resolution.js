import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PINNED_MODEL_PROVIDERS = new Map([
  ["gpt-5.6-terra", "opencode.cloudflare.dev"],
]);

const SPAWN_MODEL_CATALOG = [
  { model: "gemini-2.5-flash-lite", provider: "opencode.cloudflare.dev", tier: 1 },
  { model: "claude-haiku-4-5", provider: "opencode.cloudflare.dev", tier: 2 },
  { model: "gpt-5.6-terra", provider: "opencode.cloudflare.dev", tier: 3 },
  { model: "claude-sonnet-4-5", provider: "opencode.cloudflare.dev", tier: 4 },
];

export function spawnModelCatalog({ config = {} } = {}) {
  const extra = Array.isArray(config.spawnModelCatalog) ? config.spawnModelCatalog : [];
  const seen = new Map();
  for (const entry of [...SPAWN_MODEL_CATALOG, ...extra]) {
    if (!entry || typeof entry.model !== "string" || !entry.model.trim()) continue;
    if (!Number.isFinite(Number(entry.tier))) continue;
    seen.set(entry.model, {
      model: entry.model,
      provider: typeof entry.provider === "string" && entry.provider.trim() ? entry.provider.trim() : null,
      tier: Number(entry.tier),
    });
  }
  return [...seen.values()];
}

export function buildModelLadder(strategy, { config = {}, fallbackModel = null } = {}) {
  const catalog = spawnModelCatalog({ config });
  const type = strategy && typeof strategy === "object" ? strategy.type : null;
  if (type === "custom") {
    const models = Array.isArray(strategy.models) ? strategy.models.filter((m) => typeof m === "string" && m.trim()) : [];
    if (models.length === 0) throw new Error("modelStrategy custom requires a non-empty models array of model-name strings");
    return models.map((model) => ({ model, provider: catalog.find((c) => c.model === model)?.provider ?? null }));
  }
  if (type === "low-to-high" || type === "high-to-low") {
    if (catalog.length === 0) throw new Error(`modelStrategy ${type} requires a non-empty spawn model catalog`);
    const sorted = [...catalog].sort((a, b) => type === "low-to-high" ? a.tier - b.tier : b.tier - a.tier);
    return sorted.map(({ model, provider }) => ({ model, provider }));
  }
  if (type != null) throw new Error(`unknown modelStrategy.type "${type}"; expected low-to-high, high-to-low, or custom`);
  return fallbackModel ? [{ model: fallbackModel, provider: null }] : [];
}

function readJson(path) {
  try {
    if (!existsSync(path)) return {};
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function piAgentDirectory(env) {
  return env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
}

function configuredPiProvider(env) {
  const settings = readJson(join(piAgentDirectory(env), "settings.json"));
  return typeof settings.defaultProvider === "string" && settings.defaultProvider.trim() ? settings.defaultProvider.trim() : null;
}

function qualifiedModel(model) {
  if (typeof model !== "string") return null;
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) return null;
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

function piAgent(agent) {
  return basename(String(agent || "").trim().split(/\s+/, 1)[0] || "") === "pi";
}

function agentProvider(agent) {
  const parts = String(agent || "").trim().split(/\s+/);
  const index = parts.findIndex((part) => part === "--provider");
  return index >= 0 && parts[index + 1] ? parts[index + 1] : null;
}

export function resolveAgentModel({ agent, model, provider } = {}, { env = process.env, config = {} } = {}) {
  if (!piAgent(agent) || !model) return { model: model || null, provider: null, runner: piAgent(agent) ? "pi" : null };
  const qualified = qualifiedModel(model);
  const explicitProvider = typeof provider === "string" && provider.trim() ? provider.trim() : null;
  const configProvider = typeof config.defaultProvider === "string" && config.defaultProvider.trim() ? config.defaultProvider.trim() : null;
  const envProvider = typeof env.TERRARIUM_PROVIDER === "string" && env.TERRARIUM_PROVIDER.trim()
    ? env.TERRARIUM_PROVIDER.trim()
    : (typeof env.PI_PROVIDER === "string" && env.PI_PROVIDER.trim() ? env.PI_PROVIDER.trim() : null);
  const aliasProvider = PINNED_MODEL_PROVIDERS.get(model) || null;
  const resolvedProvider = explicitProvider || qualified?.provider || agentProvider(agent) || configProvider || envProvider || aliasProvider || configuredPiProvider(env);
  const resolvedModel = qualified && resolvedProvider === qualified.provider ? qualified.model : model;
  return { model: resolvedModel, provider: resolvedProvider || null, runner: "pi" };
}

function usableCredential(credential) {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) return false;
  if (credential.type === "oauth") {
    if (typeof credential.access !== "string" || !credential.access.trim()) return false;
    return !Number.isFinite(Number(credential.expires)) || Number(credential.expires) > Date.now();
  }
  if (credential.type === "api_key") return typeof credential.key === "string" && credential.key.trim().length > 0;
  return false;
}

function environmentCredential(provider, env) {
  if (provider === "opencode.cloudflare.dev") return Boolean(env.OPENCODE_CLOUDFLARE_TOKEN?.trim());
  const names = {
    openai: "OPENAI_API_KEY",
    "azure-openai-responses": "AZURE_OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
  };
  const name = names[provider];
  return Boolean(name && typeof env[name] === "string" && env[name].trim());
}

const EXTENSION_PROVIDED_PROVIDERS = new Set(["opencode.cloudflare.dev"]);
const NO_EXTENSION_FLAGS = new Set(["-ne", "--no-extensions"]);

export function extensionDiscoveryDisabled(agent) {
  return String(agent || "").trim().split(/\s+/).some((part) => NO_EXTENSION_FLAGS.has(part));
}

export function preflightAgentModel(resolution, { env = process.env, agent = null } = {}) {
  if (resolution.runner !== "pi" || !resolution.model) return { ok: true, provider: resolution.provider, model: resolution.model, credentialSource: null };
  if (agent && resolution.provider && EXTENSION_PROVIDED_PROVIDERS.has(resolution.provider) && extensionDiscoveryDisabled(agent)) {
    return {
      ok: false,
      provider: resolution.provider,
      model: resolution.model,
      message: `model preflight failed: provider "${resolution.provider}" is registered by a Pi extension, but the agent disables extension discovery (-ne / --no-extensions). The child would die in about one second with 'Unknown provider "${resolution.provider}"'. Remove -ne from the agent command, or disable only the colliding extension.`,
    };
  }
  if (!resolution.provider) {
    return {
      ok: false,
      provider: null,
      model: resolution.model,
      message: `model preflight failed: resolved provider <unresolved> and model "${resolution.model}". Pass --provider <provider> or configure TERRARIUM_PROVIDER before launch.`,
    };
  }
  const stored = readJson(join(piAgentDirectory(env), "auth.json"))[resolution.provider];
  if (usableCredential(stored)) return { ok: true, provider: resolution.provider, model: resolution.model, credentialSource: "pi-auth" };
  if (environmentCredential(resolution.provider, env)) return { ok: true, provider: resolution.provider, model: resolution.model, credentialSource: "environment" };
  const remediation = resolution.provider === "opencode.cloudflare.dev"
    ? "Run `pi login opencode.cloudflare.dev` or `cf-local recover opencode-access --run` followed by /opencode-cf-sync-auth, then retry."
    : `Run \`pi login ${resolution.provider}\` or configure that provider's credential, then retry.`;
  return {
    ok: false,
    provider: resolution.provider,
    model: resolution.model,
    message: `model preflight failed: resolved provider "${resolution.provider}" and model "${resolution.model}" have no usable credential. ${remediation}`,
  };
}
