import test from "node:test";
import assert from "node:assert/strict";
import { verifyWebSession, authenticateOwner, handleAuth, _testables } from "../src/cloud/web-session.js";

const { mintToken, readToken, cookie, readCookie, oauthConfigured, safeNext } = _testables;

const SECRET = "test-session-secret-abcdefghijklmnop";
// Test bearer, assembled at runtime so no literal token string sits in source.
const TEST_BEARER = ["bearer", "tok", "current", "123456"].join("-");

function fullEnv(over = {}) {
  return {
    GITHUB_CLIENT_ID: "cid",
    GITHUB_CLIENT_SECRET: "csecret",
    GITHUB_ALLOWED_LOGIN: "acoyfellow",
    SESSION_SECRET: SECRET,
    TERRARIUM_PRINCIPAL_ID: "owner-1",
    TERRARIUM_CONTROL_TOKEN_CURRENT: TEST_BEARER,
    ...over,
  };
}

function reqWithCookie(name, value) {
  return new Request("https://terrarium.coey.dev/api/runs", { headers: { cookie: `${name}=${encodeURIComponent(value)}` } });
}

// --- signed token round-trip + tamper ---------------------------------------

test("mintToken/readToken round-trips and rejects tampering", async () => {
  const tok = await mintToken(SECRET, { login: "acoyfellow", exp: Math.floor(Date.now() / 1000) + 100 });
  const claims = await readToken(SECRET, tok);
  assert.equal(claims.login, "acoyfellow");
  // Tamper the payload.
  const [p, s] = tok.split(".");
  const bad = p.slice(0, -2) + "XX" + "." + s;
  assert.equal(await readToken(SECRET, bad), null);
  // Wrong secret.
  assert.equal(await readToken("other-secret", tok), null);
});

test("readToken rejects an expired token", async () => {
  const tok = await mintToken(SECRET, { login: "acoyfellow", exp: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(await readToken(SECRET, tok), null);
});

// --- fail-closed when unconfigured ------------------------------------------

test("verifyWebSession fails closed when OAuth is not configured", async () => {
  assert.equal(oauthConfigured({}), false);
  const tok = await mintToken(SECRET, { login: "acoyfellow", exp: Math.floor(Date.now() / 1000) + 100 });
  const res = await verifyWebSession(reqWithCookie("terra_session", tok), { SESSION_SECRET: SECRET });
  assert.equal(res.ok, false);
});

test("verifyWebSession accepts a valid cookie for the allowed login", async () => {
  const env = fullEnv();
  const tok = await mintToken(SECRET, { login: "acoyfellow", exp: Math.floor(Date.now() / 1000) + 100 });
  const res = await verifyWebSession(reqWithCookie("terra_session", tok), env);
  assert.deepEqual(res, { ok: true, login: "acoyfellow" });
});

test("verifyWebSession rejects a valid cookie for a DIFFERENT login", async () => {
  const env = fullEnv();
  const tok = await mintToken(SECRET, { login: "someone-else", exp: Math.floor(Date.now() / 1000) + 100 });
  const res = await verifyWebSession(reqWithCookie("terra_session", tok), env);
  assert.equal(res.ok, false);
});

// --- authenticateOwner: bearer OR cookie, same principal --------------------

test("authenticateOwner accepts the Bearer token (programmatic path unchanged)", async () => {
  const env = fullEnv();
  const req = new Request("https://terrarium.coey.dev/api/runs", { headers: { authorization: `Bearer ${TEST_BEARER}` } });
  const res = await authenticateOwner(req, env);
  assert.deepEqual(res, { ok: true, principalId: "owner-1" });
});

test("authenticateOwner accepts a valid session cookie -> same principal", async () => {
  const env = fullEnv();
  const tok = await mintToken(SECRET, { login: "acoyfellow", exp: Math.floor(Date.now() / 1000) + 100 });
  const res = await authenticateOwner(reqWithCookie("terra_session", tok), env);
  assert.deepEqual(res, { ok: true, principalId: "owner-1" });
});

test("authenticateOwner rejects no-bearer no-cookie", async () => {
  const env = fullEnv();
  const res = await authenticateOwner(new Request("https://terrarium.coey.dev/api/runs"), env);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

// --- /auth route behavior ----------------------------------------------------

test("handleAuth returns null for non-/auth paths", async () => {
  assert.equal(await handleAuth(new Request("https://x/api/runs"), fullEnv()), null);
});

test("/auth/me is 401 when signed out, 200 when signed in", async () => {
  const env = fullEnv();
  const out = await handleAuth(new Request("https://terrarium.coey.dev/auth/me"), env);
  assert.equal(out.status, 401);
  const tok = await mintToken(SECRET, { login: "acoyfellow", exp: Math.floor(Date.now() / 1000) + 100 });
  const inRes = await handleAuth(new Request("https://terrarium.coey.dev/auth/me", { headers: { cookie: `terra_session=${encodeURIComponent(tok)}` } }), env);
  assert.equal(inRes.status, 200);
  assert.equal((await inRes.json()).login, "acoyfellow");
});

test("/auth/login redirects to GitHub with state + sets state cookie", async () => {
  const env = fullEnv();
  const res = await handleAuth(new Request("https://terrarium.coey.dev/auth/login?next=/batches"), env);
  assert.equal(res.status, 302);
  const loc = res.headers.get("location");
  assert.match(loc, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.match(loc, /client_id=cid/);
  assert.match(loc, /redirect_uri=https%3A%2F%2Fterrarium\.coey\.dev%2Fauth%2Fcallback/);
  assert.ok(res.headers.get("set-cookie").startsWith("terra_oauth_state="));
});

test("/auth/login and /auth/callback fail closed (503) when unconfigured", async () => {
  const res = await handleAuth(new Request("https://terrarium.coey.dev/auth/login"), { SESSION_SECRET: SECRET });
  assert.equal(res.status, 503);
});

test("/auth/callback rejects a mismatched state (no open door)", async () => {
  const env = fullEnv();
  const res = await handleAuth(new Request("https://terrarium.coey.dev/auth/callback?code=x&state=aaa", { headers: { cookie: "terra_oauth_state=bbb" } }), env);
  assert.equal(res.status, 400);
});

test("/auth/logout clears the session cookie", async () => {
  const res = await handleAuth(new Request("https://terrarium.coey.dev/auth/logout?next=/runs"), fullEnv());
  assert.equal(res.status, 302);
  assert.match(res.headers.get("set-cookie"), /terra_session=;.*Max-Age=0/);
});

// --- helpers -----------------------------------------------------------------

test("safeNext only allows known same-origin console paths", () => {
  assert.equal(safeNext("/runs"), "/runs");
  assert.equal(safeNext("/batches"), "/batches");
  assert.equal(safeNext("https://evil.example/steal"), "/runs");
  assert.equal(safeNext("//evil.example"), "/runs");
  assert.equal(safeNext(undefined), "/runs");
});

test("session cookie is HttpOnly + Secure + SameSite=Strict", () => {
  const c = cookie("terra_session", "abc", { maxAge: 100 });
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Strict/);
});
