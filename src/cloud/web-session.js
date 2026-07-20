// Human web-session auth for the /runs and /batches consoles.
//
// The programmatic surface (CLI, MCP, other services) authenticates with a
// Bearer control token via principal-auth.js. That path is unchanged. This
// module adds a SECOND, human-facing path so a person never pastes a token
// into a page: a GitHub OAuth web flow that mints a short-lived, HMAC-signed,
// HttpOnly session cookie. A valid cookie maps to the SAME owner principal as
// the bearer token — the console just reads/writes the owner's own runs.
//
// Fail-closed: with no GitHub OAuth config (client id/secret, session secret,
// allowed login) every auth route and every cookie check refuses. The site
// then behaves exactly as before — the API still requires a bearer, and the
// console shows "sign in" but cannot complete a login until configured.
//
// Config (Worker secrets/vars):
//   GITHUB_CLIENT_ID       — OAuth app client id.
//   GITHUB_CLIENT_SECRET   — OAuth app client secret.
//   GITHUB_ALLOWED_LOGIN   — the one GitHub login allowed to sign in (== owner).
//   SESSION_SECRET         — HMAC key for signing the session + state cookies.
//   TERRARIUM_PRINCIPAL_ID — existing owner identity a valid session maps to.

import { authenticatePrincipal } from "./principal-auth.js";

const SESSION_COOKIE = "terra_session";
const STATE_COOKIE = "terra_oauth_state";
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h
const STATE_TTL_SECONDS = 10 * 60; // 10m
const encoder = new TextEncoder();

// ---- base64url + HMAC helpers ---------------------------------------------

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function b64urlEncodeStr(str) { return b64urlEncode(encoder.encode(str)); }
function b64urlDecodeToStr(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sign(secret, payloadB64) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  return b64urlEncode(new Uint8Array(sig));
}
async function verifySig(secret, payloadB64, sigB64) {
  const key = await hmacKey(secret);
  // Recompute + constant-time compare via crypto.subtle.verify.
  let sigBytes;
  try {
    const pad = sigB64.length % 4 === 0 ? "" : "=".repeat(4 - (sigB64.length % 4));
    const bin = atob(sigB64.replaceAll("-", "+").replaceAll("_", "/") + pad);
    sigBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) sigBytes[i] = bin.charCodeAt(i);
  } catch { return false; }
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payloadB64));
}

// ---- signed token (payload.sig) -------------------------------------------

async function mintToken(secret, obj) {
  const payloadB64 = b64urlEncodeStr(JSON.stringify(obj));
  const sig = await sign(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}
async function readToken(secret, token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".", 2);
  if (!payloadB64 || !sig) return null;
  if (!(await verifySig(secret, payloadB64, sig))) return null;
  try {
    const obj = JSON.parse(b64urlDecodeToStr(payloadB64));
    if (typeof obj?.exp === "number" && obj.exp < Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch { return null; }
}

// ---- cookie parsing --------------------------------------------------------

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}
function cookie(name, value, { maxAge, expire } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", "SameSite=Strict"];
  if (expire) attrs.push("Max-Age=0");
  else if (typeof maxAge === "number") attrs.push(`Max-Age=${maxAge}`);
  return attrs.join("; ");
}

function oauthConfigured(env) {
  return Boolean(env?.GITHUB_CLIENT_ID && env?.GITHUB_CLIENT_SECRET && env?.SESSION_SECRET && env?.GITHUB_ALLOWED_LOGIN && env?.TERRARIUM_PRINCIPAL_ID);
}

// ---- public: verify a session cookie --------------------------------------

/**
 * Return { ok, login } if the request carries a valid session cookie for the
 * allowed login; otherwise { ok: false }. Fail-closed when OAuth is not
 * configured.
 */
export async function verifyWebSession(request, env) {
  if (!oauthConfigured(env)) return { ok: false };
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return { ok: false };
  const claims = await readToken(env.SESSION_SECRET, token);
  if (!claims || claims.login !== env.GITHUB_ALLOWED_LOGIN) return { ok: false };
  return { ok: true, login: claims.login };
}

/**
 * Combined owner auth for API handlers: accept a valid Bearer control token
 * (programmatic path, unchanged) OR a valid web-session cookie (human path).
 * Both resolve to the SAME owner principal. Returns the principal-auth shape:
 * { ok, principalId } or { ok:false, status, error }.
 */
export async function authenticateOwner(request, env) {
  const bearer = authenticatePrincipal(request, env);
  if (bearer.ok) return bearer;
  const session = await verifyWebSession(request, env);
  if (session.ok) return { ok: true, principalId: env.TERRARIUM_PRINCIPAL_ID };
  return { ok: false, status: 401, error: "unauthorized" };
}

// ---- public: /auth/* route handler ----------------------------------------

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}
function safeNext(raw) {
  // Only allow same-origin absolute paths to a known console; never an open redirect.
  if (typeof raw !== "string") return "/runs";
  if (raw === "/runs" || raw === "/batches") return raw;
  return "/runs";
}

/**
 * Handle /auth/login, /auth/callback, /auth/logout, /auth/me. Returns null for
 * any non-/auth path so the caller can continue routing.
 */
export async function handleAuth(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/auth/")) return null;

  // /auth/me — cheap "am I signed in?" probe for the console.
  if (path === "/auth/me" && request.method === "GET") {
    const s = await verifyWebSession(request, env);
    if (s.ok) return Response.json({ ok: true, login: s.login });
    return Response.json({ ok: false, configured: oauthConfigured(env) }, { status: 401 });
  }

  // /auth/logout — clear the session cookie.
  if (path === "/auth/logout") {
    const next = safeNext(url.searchParams.get("next"));
    return redirect(next, { "set-cookie": cookie(SESSION_COOKIE, "", { expire: true }) });
  }

  // Everything below needs OAuth configured; fail closed otherwise.
  if (!oauthConfigured(env)) {
    return Response.json({ ok: false, error: "oauth not configured" }, { status: 503 });
  }

  // /auth/login — start the GitHub OAuth web flow.
  if (path === "/auth/login" && request.method === "GET") {
    const next = safeNext(url.searchParams.get("next"));
    const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const state = await mintToken(env.SESSION_SECRET, { nonce, next, exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS });
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
    authorize.searchParams.set("scope", "read:user");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("allow_signup", "false");
    return redirect(authorize.toString(), { "set-cookie": cookie(STATE_COOKIE, state, { maxAge: STATE_TTL_SECONDS }) });
  }

  // /auth/callback — verify state, exchange code, check login, set session.
  if (path === "/auth/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const cookieState = readCookie(request, STATE_COOKIE);
    if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
      return new Response("bad oauth state", { status: 400, headers: { "set-cookie": cookie(STATE_COOKIE, "", { expire: true }) } });
    }
    const stateClaims = await readToken(env.SESSION_SECRET, returnedState);
    if (!stateClaims) return new Response("expired oauth state", { status: 400, headers: { "set-cookie": cookie(STATE_COOKIE, "", { expire: true }) } });

    // Exchange the code for an access token.
    let accessToken;
    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/callback` }),
      });
      const tokenBody = await tokenRes.json();
      accessToken = tokenBody?.access_token;
    } catch { accessToken = null; }
    if (!accessToken) return new Response("oauth exchange failed", { status: 502, headers: { "set-cookie": cookie(STATE_COOKIE, "", { expire: true }) } });

    // Look up the GitHub identity.
    let login = null;
    try {
      const userRes = await fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "terrarium-control" },
      });
      const user = await userRes.json();
      login = typeof user?.login === "string" ? user.login : null;
    } catch { login = null; }

    // Only the one allowed login may sign in.
    if (!login || login !== env.GITHUB_ALLOWED_LOGIN) {
      return new Response("not authorized for this instance", { status: 403, headers: { "set-cookie": cookie(STATE_COOKIE, "", { expire: true }) } });
    }

    const session = await mintToken(env.SESSION_SECRET, { login, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS });
    const headers = new Headers();
    headers.append("set-cookie", cookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_SECONDS }));
    headers.append("set-cookie", cookie(STATE_COOKIE, "", { expire: true }));
    headers.set("location", safeNext(stateClaims.next));
    return new Response(null, { status: 302, headers });
  }

  return new Response("not found", { status: 404 });
}

export const _testables = { mintToken, readToken, cookie, readCookie, oauthConfigured, safeNext };
