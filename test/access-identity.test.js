import test from "node:test";
import assert from "node:assert/strict";
import { authenticateAccessUser, emailPrincipalId, verifyAccessAssertion, _testables } from "../src/cloud/access-identity.js";
import { authenticateOwner } from "../src/cloud/web-session.js";

const TEAM = "team.example.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const AUD = "aud-terrarium";

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function signingFixture() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "kid-1", alg: "RS256", use: "sig" };
  const sign = async (claims, { kid = "kid-1", key = pair.privateKey } = {}) => {
    const header = base64Url(Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
    const payload = base64Url(Buffer.from(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  return { sign, fetchImpl };
}

const config = { issuer: ISSUER, audiences: [AUD] };
const now = Math.floor(Date.now() / 1000);
const validClaims = (extra = {}) => ({ iss: ISSUER, aud: [AUD], email: "Jane@Example.com", exp: now + 600, nbf: now - 5, ...extra });

test.beforeEach(() => _testables.jwksCache.clear());

test("a signed Access user assertion resolves to a per-email principal", async () => {
  const { sign, fetchImpl } = await signingFixture();
  const verified = await verifyAccessAssertion(await sign(validClaims()), config, { fetchImpl });
  assert.equal(verified.ok, true);
  assert.equal(verified.email, "jane@example.com");
  assert.equal(verified.principalId, "user:jane:example.com");
  assert.match(verified.principalId, /^[A-Za-z0-9._:-]{1,128}$/);
});

test("Access assertions with the wrong audience, issuer, expiry, or key are refused", async () => {
  const { sign, fetchImpl } = await signingFixture();
  const other = await signingFixture();
  const cases = [
    [await sign(validClaims({ aud: ["someone-else"] })), "wrong-audience"],
    [await sign(validClaims({ iss: "https://evil.cloudflareaccess.com" })), "wrong-issuer"],
    [await sign(validClaims({ exp: now - 3600 })), "expired"],
    [await sign(validClaims(), { kid: "kid-unknown" }), "unknown-key"],
    [await other.sign(validClaims()), "bad-signature"],
    [await sign(validClaims({ email: undefined, common_name: "service-token-id" })), "no-user-identity"],
  ];
  for (const [token, reason] of cases) {
    const verified = await verifyAccessAssertion(token, config, { fetchImpl });
    assert.equal(verified.ok, false, reason);
    assert.equal(verified.reason, reason);
  }
});

test("two different Access users map to two different principals", () => {
  assert.notEqual(emailPrincipalId("jane@example.com"), emailPrincipalId("john@example.com"));
  assert.equal(emailPrincipalId("JANE@example.com"), emailPrincipalId("jane@example.com"));
});

test("owner auth prefers a verified Access user over any bearer token", async () => {
  const { sign, fetchImpl } = await signingFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const env = { TERRARIUM_ACCESS_TEAM_DOMAIN: TEAM, TERRARIUM_ACCESS_AUD: AUD, TERRARIUM_PRINCIPAL_ID: "shared-owner", TERRARIUM_CONTROL_TOKEN_CURRENT: "control" };
    const request = new Request("https://terrarium.example/api/runs", { headers: { "cf-access-jwt-assertion": await sign(validClaims()), authorization: "Bearer control" } });
    assert.deepEqual(await authenticateOwner(request, env), { ok: true, principalId: "user:jane:example.com" });
    const bearerOnly = new Request("https://terrarium.example/api/runs", { headers: { authorization: "Bearer control" } });
    assert.deepEqual(await authenticateOwner(bearerOnly, env), { ok: true, principalId: "shared-owner" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Access identity stays off unless both team domain and audience are configured", async () => {
  const request = new Request("https://terrarium.example/api/runs", { headers: { "cf-access-jwt-assertion": "x.y.z" } });
  assert.equal(await authenticateAccessUser(request, { TERRARIUM_ACCESS_TEAM_DOMAIN: TEAM }), null);
  assert.equal(await authenticateAccessUser(request, { TERRARIUM_ACCESS_AUD: AUD }), null);
});
