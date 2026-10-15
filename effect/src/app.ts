import { Effect, Layer, Schema } from "effect";

import { ProbeBoxes, runProbe } from "./egress.ts";
import { accessConfigLayer, authenticate, fetchJwks } from "./identity.ts";
import { approveLoop, cancelLoop, createLoop, deleteLoop, getLoop, hookWake, listLoops, wakeLoop } from "./loops-api.ts";
import type { LoopsEnv } from "./loops-api.ts";
import { CallbacksLive, RunsLive, cloudflareLayer } from "./runs.ts";
import type { RunsEnv } from "./runs.ts";
import { sessionReplaceBox, sessionSteer, sessionTurn } from "./sessions-api.ts";
import { errorResponse, handleRuns } from "./runs-api.ts";
import { Clock, Ids, NotFound, Owner, Runs, Upstream } from "./shared.ts";
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

const SESSION_ROUTES = new Map([["turn", sessionTurn], ["steer", sessionSteer], ["replace-box", (_request: Request, name: string) => sessionReplaceBox(name)]]);

const whoami = Effect.map(Owner, (owner) => Response.json({ ok: true, method: owner.method, owner: owner.id, email: owner.email ?? undefined }));

const route = (request: Request, env: AppEnv): Effect.Effect<Response, HttpFailure, Owner | ProbeBoxes> => {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;

  if (key === "GET /api/whoami") return whoami;

  if (key === "GET /api/egress-probe") return Effect.map(runProbe, (report) => Response.json(report));

  if (key === "POST /api/loops") return createLoop(request, env);

  if (key === "GET /api/loops") return listLoops(request, env);

  if (request.method === "GET" && /^\/api\/loops\/[^/]+$/.test(url.pathname)) return getLoop(request, env);

  if (request.method === "POST" && /^\/api\/loops\/[^/]+\/cancel$/.test(url.pathname)) return cancelLoop(request, env);

  if (request.method === "POST" && /^\/api\/loops\/[^/]+\/wake$/.test(url.pathname)) return wakeLoop(request, env);

  if (request.method === "POST" && new RegExp("^/api/loops/[^/]+/approval$").test(url.pathname)) return approveLoop(request, env);

  if (request.method === "DELETE" && /^\/api\/loops\/[^/]+$/.test(url.pathname)) return deleteLoop(request, env);

  const sessionPath = new RegExp("^/api/sessions/([^/]+)/(turn|steer|replace-box)$").exec(url.pathname);

  if (request.method === "POST" && sessionPath !== null) return SESSION_ROUTES.get(sessionPath[2])?.(request, sessionPath[1]) ?? Effect.fail(new NotFound({ what: "route" }));

  const activityPath = /^\/api\/runs\/([^/]+)\/activity$/.exec(url.pathname);

  if (request.method === "GET" && activityPath !== null) return runActivity(activityPath[1], Number(url.searchParams.get("after") ?? 0)).pipe(Effect.provide(runsLayer(env)));

  if (url.pathname.startsWith("/api/runs") || key === "POST /claim" || key === "POST /ack") return handleRuns(request).pipe(Effect.provide(runsLayer(env)));

  return Effect.fail(new NotFound({ what: "route" }));
};

const runActivity = (runId: string, afterMs: number): Effect.Effect<Response, HttpFailure, Owner | ProbeBoxes | Runs> =>
  Effect.gen(function* () {
    const runs = yield* Runs;
    const boxes = yield* ProbeBoxes;
    const record = yield* runs.get(runId);
    const events = yield* Effect.tryPromise({ try: () => boxes.activity(record.runId, Number.isFinite(afterMs) ? afterMs : 0), catch: (cause) => new Upstream({ service: "sandbox", detail: String(cause) }) });

    return Response.json({ ok: true, runId: record.runId, status: record.terminal?.status ?? "running", createdAt: record.createdAt, events });
  });

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

  if (request.method === "POST" && /^\/hooks\/loops\/[^/]+\/wake$/.test(pathname)) return Effect.runPromise(hookWake(request, env).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error)))));

  if (!isApiPath(pathname)) return env.ASSETS.fetch(request);

  return Effect.runPromise(authenticated(request, env).pipe(Effect.provideService(ProbeBoxes, probeBoxes), Effect.catch((error) => Effect.succeed(errorResponse(error)))));
};
