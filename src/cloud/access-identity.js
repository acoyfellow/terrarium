const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const JWKS_CACHE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const EMAIL_PRINCIPAL_PREFIX = "user:";

const jwksCache = new Map();

function base64UrlToBytes(value) {
  const standard = value.replaceAll("-", "+").replaceAll("_", String.fromCharCode(47));
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJsonSegment(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

export function accessIdentityConfig(env) {
  const teamDomain = typeof env?.TERRARIUM_ACCESS_TEAM_DOMAIN === "string" ? env.TERRARIUM_ACCESS_TEAM_DOMAIN.trim().replace(/\/$/, "") : "";
  const audiences = typeof env?.TERRARIUM_ACCESS_AUD === "string"
    ? env.TERRARIUM_ACCESS_AUD.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  if (!teamDomain || audiences.length === 0) return null;
  const issuer = teamDomain.startsWith("https://") ? teamDomain : `https://${teamDomain}`;
  return { issuer, audiences };
}

async function signingKeys(issuer, fetchImpl, now) {
  const cached = jwksCache.get(issuer);
  if (cached && now - cached.fetchedAt < JWKS_CACHE_MS) return cached.keys;
  const response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`access certs unavailable: ${response.status}`);
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  jwksCache.set(issuer, { keys, fetchedAt: now });
  return keys;
}

async function verifySignature(jwk, signingInput, signature) {
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(signingInput));
}

export function emailPrincipalId(email) {
  const normalized = email.toLowerCase().replace("@", ":").replace(/[^a-z0-9._:-]/g, "-");
  return `${EMAIL_PRINCIPAL_PREFIX}${normalized}`.slice(0, 128);
}

export async function verifyAccessAssertion(token, config, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header;
  let claims;
  try {
    header = decodeJsonSegment(parts[0]);
    claims = decodeJsonSegment(parts[1]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header?.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "unsupported-alg" };
  const keys = await signingKeys(config.issuer, fetchImpl, nowMs);
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unknown-key" };
  const valid = await verifySignature(jwk, `${parts[0]}.${parts[1]}`, base64UrlToBytes(parts[2]));
  if (!valid) return { ok: false, reason: "bad-signature" };
  const nowSeconds = Math.floor(nowMs / 1000);
  if (claims.iss !== config.issuer) return { ok: false, reason: "wrong-issuer" };
  const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!tokenAudiences.some((audience) => config.audiences.includes(audience))) return { ok: false, reason: "wrong-audience" };
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) return { ok: false, reason: "not-yet-valid" };
  if (typeof claims.email !== "string" || !claims.email.includes("@")) return { ok: false, reason: "no-user-identity" };
  return { ok: true, email: claims.email.toLowerCase(), principalId: emailPrincipalId(claims.email) };
}

export async function authenticateAccessUser(request, env, options = {}) {
  const config = accessIdentityConfig(env);
  if (!config) return null;
  const assertion = request.headers.get(ACCESS_ASSERTION_HEADER);
  if (!assertion) return null;
  try {
    const verified = await verifyAccessAssertion(assertion, config, options);
    return verified.ok ? { ok: true, principalId: verified.principalId, email: verified.email } : null;
  } catch {
    return null;
  }
}

export const _testables = { jwksCache };
