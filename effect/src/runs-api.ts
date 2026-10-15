import { Effect, Match, Schema } from "effect";

import { Callbacks } from "./runs.ts";
import { BadRequest, IdempotencyKey, NotFound, Owner, Runs, RunId, TerminalStatus } from "./shared.ts";
import type { HttpFailure, RunRecord } from "./shared.ts";

const RunBody = Schema.Struct({ task: Schema.String, proof: Schema.optional(Schema.NullOr(Schema.String)), channel: Schema.optional(Schema.NullOr(Schema.String)) });

const ClaimBody = Schema.Struct({ subscriberId: Schema.String, limit: Schema.optional(Schema.Int) });

const AckBody = Schema.Struct({ subscriberId: Schema.String, eventId: Schema.String });

const json = <B>(status: number, body: B): Response => Response.json(body, { status });

const errorStatus = (error: HttpFailure): number => Match.valueTags(error, {
  Unauthorized: () => 401,
  NotFound: () => 404,
  BadRequest: () => 400,
  Conflict: () => 409,
  RateLimited: () => 429,
  Upstream: () => 502,
});

export const errorResponse = (error: HttpFailure): Response => json(errorStatus(error), { ok: false, error: error._tag, detail: error });

const asBadRequest = (error: Schema.SchemaError): BadRequest => new BadRequest({ problems: [error.message] });

const decodeWith = <S extends Schema.Decoder<unknown>>(schema: S, input: string | null) => Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(asBadRequest));

const bodyOf = <S extends Schema.Decoder<unknown>>(request: Request, schema: S) =>
  Effect.tryPromise({ try: () => request.json(), catch: () => new BadRequest({ problems: ["body must be JSON"] }) }).pipe(Effect.flatMap((input) => Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(asBadRequest))));

const runView = (record: RunRecord) => ({ ok: true, runId: record.runId, channel: record.channel, createdAt: record.createdAt, status: record.terminal?.status ?? "running", terminal: record.terminal, startAttempts: record.startAttempts ?? 0 });

const admitRun = (request: Request) => Effect.gen(function* () {
  const idempotencyKey = yield* decodeWith(IdempotencyKey, request.headers.get("idempotency-key"));
  const body = yield* bodyOf(request, RunBody);
  const runs = yield* Runs;
  const record = yield* runs.admit({ task: body.task, proof: body.proof ?? null, channel: body.channel ?? null, idempotencyKey });

  return json(202, { ok: true, runId: record.runId, contract: record.contract });
});

const listRuns = (url: URL) => Effect.gen(function* () {
  const runs = yield* Runs;
  const status = url.searchParams.get("status");
  const statusFilter = status === null ? null : yield* decodeWith(Schema.Union([TerminalStatus, Schema.Literal("running")]), status);
  const records = yield* runs.list(url.searchParams.get("channel"), Number(url.searchParams.get("limit") ?? 50) || 50);
  const views = records.map(runView).filter((view) => statusFilter === null || view.status === statusFilter);

  return json(200, { ok: true, runs: views });
});

const runAction = (request: Request, rawRunId: string, action: string) => Effect.gen(function* () {
  const runId = yield* decodeWith(RunId, rawRunId).pipe(Effect.mapError(() => new NotFound({ what: "run" })));
  const runs = yield* Runs;

  if (action === "cancel" && request.method === "POST") return json(200, runView(yield* runs.cancel(runId)));

  if (request.method !== "GET") return yield* new NotFound({ what: "route" });

  const record = yield* runs.get(runId);

  if (action === "status") return json(200, runView(record));

  if (action === "logs") return json(200, { ok: true, runId, logs: record.logs });

  return yield* new NotFound({ what: "route" });
});

const claimEvents = (request: Request) => Effect.gen(function* () {
  const body = yield* bodyOf(request, ClaimBody);
  const callbacks = yield* Callbacks;

  return json(200, { ok: true, events: yield* callbacks.claim(body.subscriberId, body.limit ?? 10) });
});

const ackEvent = (request: Request) => Effect.gen(function* () {
  const body = yield* bodyOf(request, AckBody);
  const callbacks = yield* Callbacks;

  return json(200, { ok: true, eventId: yield* callbacks.ack(body.subscriberId, body.eventId) });
});

const route = (request: Request): Effect.Effect<Response, HttpFailure, Runs | Callbacks | Owner> => {
  const url = new URL(request.url);
  const runPath = /^\/api\/runs\/([^/]+)\/(status|logs|cancel)$/.exec(url.pathname);

  if (runPath !== null) return runAction(request, runPath[1], runPath[2]);

  const key = `${request.method} ${url.pathname}`;

  if (key === "POST /api/runs") return admitRun(request);

  if (key === "GET /api/runs") return listRuns(url);

  if (key === "POST /claim") return claimEvents(request);

  if (key === "POST /ack") return ackEvent(request);

  return Effect.fail(new NotFound({ what: "route" }));
};

export const handleRuns = (request: Request) => route(request).pipe(Effect.catch((error) => Effect.succeed(errorResponse(error))));
