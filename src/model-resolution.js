import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PINNED_MODEL_PROVIDERS = new Map([
  ["gpt-5.6-terra", "opencode.cloudflare.dev"],
]);

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

export function preflightAgentModel(resolution, { env = process.env } = {}) {
  if (resolution.runner !== "pi" || !resolution.model) return { ok: true, provider: resolution.provider, model: resolution.model, credentialSource: null };
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
