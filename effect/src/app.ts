import { Effect, Layer, Schema } from "effect";

import { ProbeBoxes, runProbe } from "./egress.ts";
import { accessConfigLayer, authenticate, fetchJwks } from "./identity.ts";
import { createLoop, getLoop, listLoops } from "./loops-api.ts";
import type { LoopsEnv } from "./loops-api.ts";
import { CallbacksLive, RunsLive, cloudflareLayer } from "./runs.ts";
import type { RunsEnv } from "./runs.ts";
import { errorResponse, handleRuns } from "./runs-api.ts";
import { Clock, Ids, NotFound, Owner, Upstream } from "./shared.ts";
import type { HttpFailure } from "./shared.ts";

export interface AppEnv extends RunsEnv, LoopsEnv {
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> };
  readonly TERRARIUM_ACCESS_TEAM_DOMAIN: string;
  readonly TERRARIUM_ACCESS_AUD: string;
  readonly TERRARIUM_PRINCIPALS: string;
}

const Principals = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, token: Schema.String })));

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const LiveClock = Layer.succeed(Clock, Clock.of({ nowMs: Effect.sync(() => Date.now()) }));

export const LiveIds = Layer.succeed(Ids, Ids.of({
  runId: Effect.sync(() => `ter_${Date.now().toString(36)}_${hex(6)}`),
  loopId: Effect.sync(() => `loop_${hex(16)}`),
  nonce: Effect.sync(() => hex(16)),
}));

export const runsLayer = (env: RunsEnv) => Layer.mergeAll(RunsLive, CallbacksLive).pipe(Layer.provide(Layer.mergeAll(cloudflareLayer(env), LiveClock, LiveIds)));

const accessLayer = (env: AppEnv) =>
  Schema.decodeUnknownEffect(Principals)(env.TERRARIUM_PRINCIPALS ?? "[]").pipe(
    Effect.mapError(() => new Upstream({ service: "config", detail: "TERRARIUM_PRINCIPALS must be a JSON array of {id, token}" })),
    Effect.map((principals) => accessConfigLayer({ teamDomain: env.TERRARIUM_ACCESS_TEAM_DOMAIN, aud: env.TERRARIUM_ACCESS_AUD, principals, fetchCerts: fetchJwks })),
  );

const whoami = Effect.map(Owner, (owner) => Response.json({ ok: true, method: owner.method, owner: owner.id, email: owner.email ?? undefined }));

const route = (request: Request, env: AppEnv): Effect.Effect<Response, HttpFailure, Owner | ProbeBoxes> => {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;

  if (key === "GET /api/whoami") return whoami;

  if (key === "GET /api/egress-probe") return Effect.map(runProbe, (report) => Response.json(report));

  if (key === "POST /api/loops") return createLoop(request, env);

  if (key === "GET /api/loops") return listLoops(request, env);

  if (request.method === "GET" && /^\/api\/loops\/[^/]+$/.test(url.pathname)) return getLoop(request, env);

  if (url.pathname.startsWith("/api/runs") || key === "POST /claim" || key === "POST /ack") return handleRuns(request).pipe(Effect.provide(runsLayer(env)));

  return Effect.fail(new NotFound({ what: "route" }));
};

const authenticated = (request: Request, env: AppEnv): Effect.Effect<Response, HttpFailure, ProbeBoxes> =>
  Effect.gen(function* () {
    const access = yield* accessLayer(env);
    const identity = yield* authenticate(request).pipe(Effect.provide(access));

    return yield* route(request, env).pipe(Effect.provideService(Owner, Owner.of(identity)));
  });

const isApiPath = (pathname: string) => pathname.startsWith("/api/") || pathname === "/claim" || pathname === "/ack";

export const handleRequest = (request: Request, env: AppEnv, probeBoxes: typeof ProbeBoxes.Service): Promise<Response> => {
  const { pathname } = new URL(request.url);

  if (pathname === "/health") return Promise.resolve(Response.json({ ok: true }));

  if (!isApiPath(pathname)) return env.ASSETS.fetch(request);

  return Effect.runPromise(authenticated(request, env).pipe(Effect.provideService(ProbeBoxes, probeBoxes), Effect.catch((error) => Effect.succeed(errorResponse(error)))));
};
