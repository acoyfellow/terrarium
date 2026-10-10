import { execFileSync, spawnSync } from "node:child_process";

const TOKEN_CACHE_MS = 60 * 1000;
const cachedTokens = new Map();

function cloudflaredAvailable() {
  const probe = spawnSync("cloudflared", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

function decodeExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function storedAccessUserToken(url, { nowMs = Date.now(), run = execFileSync } = {}) {
  if (!url) return "";
  const cached = cachedTokens.get(url);
  if (cached && cached.checkedAt + TOKEN_CACHE_MS > nowMs && cached.expiresAt > nowMs) return cached.token;
  let token = "";
  try {
    token = String(run("cloudflared", ["access", "token", `--app=${url}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })).trim();
  } catch {
    token = "";
  }
  const expiresAt = decodeExpiry(token);
  if (!token.includes(".") || expiresAt <= nowMs) {
    cachedTokens.delete(url);
    return "";
  }
  cachedTokens.set(url, { token, expiresAt, checkedAt: nowMs });
  return token;
}

export function accessUserHeaders(url, options = {}) {
  const token = storedAccessUserToken(url, options);
  return token ? { "cf-access-token": token } : {};
}

export function loginWithAccess(url) {
  if (!url) throw new Error("terra login needs a cloud URL: set TERRARIUM_URL or cloudUrl in ~/.terrarium/config.json");
  if (!cloudflaredAvailable()) throw new Error("terra login needs cloudflared: brew install cloudflared");
  const result = spawnSync("cloudflared", ["access", "login", url], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("cloudflared access login did not complete");
  cachedTokens.delete(url);
  const token = storedAccessUserToken(url);
  if (!token) throw new Error("login finished but no Access token is available for this URL");
  return { url, expiresAt: new Date(decodeExpiry(token)).toISOString() };
}

export const _testables = { cachedTokens, decodeExpiry };
