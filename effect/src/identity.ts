import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { Unauthorized } from "./shared.ts";

export const Jwk = Schema.Struct({ kid: Schema.String, kty: Schema.Literal("RSA"), n: Schema.String, e: Schema.String });

export const Jwks = Schema.Struct({ keys: Schema.Array(Jwk) });

export type Jwks = typeof Jwks.Type;

export type Principal = { readonly id: string; readonly token: string };

export class AccessConfig extends Context.Service<AccessConfig, {
  readonly teamDomain: string;
  readonly aud: string;
  readonly principals: ReadonlyArray<Principal>;
  readonly fetchCerts: (url: string) => Effect.Effect<Jwks, Unauthorized>;
}>()("terrarium/AccessConfig") {}

export type Identity = { readonly id: string; readonly method: "access-user" | "bearer"; readonly email: string | null };

const JwtHeader = Schema.fromJsonString(Schema.Struct({ alg: Schema.Literal("RS256"), kid: Schema.String }));

const JwtPayload = Schema.fromJsonString(Schema.Struct({
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  iss: Schema.String,
  exp: Schema.Number,
  nbf: Schema.optional(Schema.Number),
  email: Schema.optional(Schema.String),
}));

const deny = (reason: string) => new Unauthorized({ reason });

const base64UrlBytes = (segment: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(segment, "base64url"));

const base64UrlText = (segment: string) => new TextDecoder().decode(base64UrlBytes(segment));

const decodeSegment = <S extends Schema.Decoder<unknown>>(schema: S, segment: string, what: string) =>
  Schema.decodeUnknownEffect(schema)(base64UrlText(segment)).pipe(Effect.mapError(() => deny(`malformed ${what}`)));

export const fetchJwks = (url: string): Effect.Effect<Jwks, Unauthorized> =>
  Effect.tryPromise({ try: () => fetch(url).then((response) => response.json()), catch: () => deny("cert fetch failed") }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Jwks)),
    Effect.mapError(() => deny("cert fetch failed")),
  );

export const accessConfigLayer = (config: AccessConfig["Service"]) => Layer.succeed(AccessConfig, config);

const constantTimeEqual = (left: string, right: string) => {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;

  for (let index = 0; index < length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);

  return difference === 0;
};

const ownerFromEmail = (email: string) => {
  const [local, domain, ...rest] = email.toLowerCase().split("@");

  return local && domain && rest.length === 0 ? Effect.succeed(`user:${local}:${domain}`) : Effect.fail(deny("invalid email"));
};

const verifySignature = (jwk: typeof Jwk.Type, signed: string, signature: string) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle
        .importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
        .then((key) => crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(signature), new TextEncoder().encode(signed))),
    catch: () => deny("invalid key"),
  }).pipe(Effect.filterOrFail((valid) => valid, () => deny("bad signature")));

const verifyAccessJwt = (token: string) =>
  Effect.gen(function* () {
    const config = yield* AccessConfig;
    const [headerSegment, payloadSegment, signature, ...extra] = token.split(".");

    if (!headerSegment || !payloadSegment || !signature || extra.length > 0) return yield* Effect.fail(deny("malformed token"));

    const header = yield* decodeSegment(JwtHeader, headerSegment, "header");
    const payload = yield* decodeSegment(JwtPayload, payloadSegment, "payload");
    const jwks = yield* config.fetchCerts(`https://${config.teamDomain}/cdn-cgi/access/certs`);

    const jwk = yield* Option.match(Option.fromNullishOr(jwks.keys.find((key) => key.kid === header.kid)), {
      onNone: () => Effect.fail(deny("unknown kid")),
      onSome: Effect.succeed,
    });

    yield* verifySignature(jwk, `${headerSegment}.${payloadSegment}`, signature);

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];

    if (!audiences.includes(config.aud)) return yield* Effect.fail(deny("wrong aud"));

    if (payload.iss !== `https://${config.teamDomain}`) return yield* Effect.fail(deny("wrong iss"));

    const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;

    if (payload.exp <= nowSeconds) return yield* Effect.fail(deny("expired"));

    if (payload.nbf !== undefined && payload.nbf > nowSeconds) return yield* Effect.fail(deny("not yet valid"));

    if (!payload.email) return yield* Effect.fail(deny("no email"));

    const id = yield* ownerFromEmail(payload.email);
    const identity: Identity = { id, method: "access-user", email: payload.email };

    return identity;
  });

const verifyBearer = (token: string) =>
  Effect.gen(function* () {
    const config = yield* AccessConfig;
    const matches = config.principals.filter((principal) => constantTimeEqual(principal.token, token));
    const [principal] = matches;

    if (!principal) return yield* Effect.fail(deny("unknown bearer"));

    const identity: Identity = { id: principal.id, method: "bearer", email: null };

    return identity;
  });

export const authenticate = (request: Request): Effect.Effect<Identity, Unauthorized, AccessConfig> => {
  const userJwt = request.headers.get("cf-access-token");
  const edgeJwt = request.headers.get("cf-access-jwt-assertion");
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();

  if (userJwt) return verifyAccessJwt(userJwt);

  if (bearer) return verifyBearer(bearer);

  return edgeJwt ? verifyAccessJwt(edgeJwt) : Effect.fail(deny("no credentials"));
};
