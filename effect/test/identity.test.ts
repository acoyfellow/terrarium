import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Exit } from "effect";
import { accessConfigLayer, authenticate, type Jwks } from "../src/identity.ts";

const teamDomain = "team.cloudflareaccess.com";

const aud = "aud-123";

const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);

const jwks: Jwks = { keys: [{ kid: "k1", kty: "RSA", n: publicJwk.n ?? "", e: publicJwk.e ?? "" }] };

const machineToken = crypto.randomUUID();

const layer = accessConfigLayer({ teamDomain, aud, principals: [{ id: "ci-bot", token: machineToken }], fetchCerts: () => Effect.succeed(jwks) });

const encode = (value: string) => Buffer.from(value).toString("base64url");

const now = Math.floor(Date.now() / 1000);

const validClaims = { aud: [aud], iss: `https://${teamDomain}`, exp: now + 300, nbf: now - 10, email: "Ada@Example.com" };

type Claims = Partial<typeof validClaims> & { readonly aud?: ReadonlyArray<string> };

const sign = async (claims: Claims, kid = "k1") => {
  const signed = `${encode(JSON.stringify({ alg: "RS256", kid }))}.${encode(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(signed));

  return `${signed}.${Buffer.from(signature).toString("base64url")}`;
};

const run = (headers: Record<string, string>) => Effect.runPromiseExit(authenticate(new Request("https://x/api", { headers })).pipe(Effect.provide(layer)));

const rejects = async (headers: Record<string, string>, reason: string) => {
  const exit = await run(headers);

  assert.ok(Exit.isFailure(exit));
  assert.match(JSON.stringify(exit.cause), new RegExp(reason));
};

test("valid access token yields user owner", async () => {
  const exit = await run({ "cf-access-jwt-assertion": await sign(validClaims) });

  assert.deepEqual(exit, Exit.succeed({ id: "user:ada:example.com", method: "access-user", email: "Ada@Example.com" }));
});

test("cf-access-token header is accepted", async () => {
  assert.ok(Exit.isSuccess(await run({ "cf-access-token": await sign(validClaims) })));
});

test("wrong aud", async () => rejects({ "cf-access-jwt-assertion": await sign({ ...validClaims, aud: ["other"] }) }, "wrong aud"));

test("wrong iss", async () => rejects({ "cf-access-jwt-assertion": await sign({ ...validClaims, iss: "https://evil" }) }, "wrong iss"));

test("expired", async () => rejects({ "cf-access-jwt-assertion": await sign({ ...validClaims, exp: now - 1 }) }, "expired"));

test("unknown kid", async () => rejects({ "cf-access-jwt-assertion": await sign(validClaims, "nope") }, "unknown kid"));

test("tampered signature", async () => {
  const [header, , signature] = (await sign(validClaims)).split(".");
  const forged = `${header}.${encode(JSON.stringify({ ...validClaims, email: "eve@example.com" }))}.${signature}`;

  await rejects({ "cf-access-jwt-assertion": forged }, "bad signature");
});

test("no email", async () => rejects({ "cf-access-jwt-assertion": await sign({ ...validClaims, email: undefined }) }, "no email"));

test("valid bearer", async () => {
  assert.deepEqual(await run({ authorization: `Bearer ${machineToken}` }), Exit.succeed({ id: "ci-bot", method: "bearer", email: null }));
});

test("wrong bearer", async () => rejects({ authorization: `Bearer ${crypto.randomUUID()}` }, "unknown bearer"));

test("no credentials", async () => rejects({}, "no credentials"));

test("a machine bearer behind a service-token Access edge is the bearer principal, not the service", async () => {
  const edge = await sign({ ...validClaims, email: undefined });
  assert.deepEqual(await run({ "cf-access-jwt-assertion": edge, authorization: `Bearer ${machineToken}` }), Exit.succeed({ id: "ci-bot", method: "bearer", email: null }));
});

test("an explicit user token wins over a bearer", async () => {
  const exit = await run({ "cf-access-token": await sign(validClaims), authorization: `Bearer ${machineToken}` });
  assert.ok(Exit.isSuccess(exit));
  assert.equal(exit.value.method, "access-user");
});
