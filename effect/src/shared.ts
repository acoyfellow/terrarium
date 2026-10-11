import { Context, Effect, Schema } from "effect";

export const OwnerId = Schema.String.check(Schema.isPattern(/^(user:[^:\s]+:[^:\s]+|[A-Za-z0-9._-]{1,64})$/));

export type OwnerId = typeof OwnerId.Type;

export const RunId = Schema.String.check(Schema.isPattern(/^ter_[a-z0-9]{6,12}_[a-f0-9]{12}$/));

export type RunId = typeof RunId.Type;

export const LoopId = Schema.String.check(Schema.isPattern(/^loop_[a-z0-9]{8,40}$/));

export type LoopId = typeof LoopId.Type;

export const IdempotencyKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~+/=-]{8,255}$/));

export const TerminalStatus = Schema.Literals(["done", "failed", "cancelled", "timeout"]);

export type TerminalStatus = typeof TerminalStatus.Type;

export const ContractStatus = Schema.Literals(["verified", "missing", "mismatch", "malformed"]);

export type ContractStatus = typeof ContractStatus.Type;

export const RunContract = Schema.Struct({
  runId: RunId,
  taskFingerprint: Schema.String,
  nonce: Schema.String,
});

export type RunContract = typeof RunContract.Type;

export const RunTerminal = Schema.Struct({
  status: TerminalStatus,
  contractStatus: ContractStatus,
  summary: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  finishedAt: Schema.String,
});

export type RunTerminal = typeof RunTerminal.Type;

export const RunRecord = Schema.Struct({
  runId: RunId,
  ownerId: OwnerId,
  task: Schema.String,
  channel: Schema.NullOr(Schema.String),
  contract: RunContract,
  createdAt: Schema.String,
  terminal: Schema.NullOr(RunTerminal),
  logs: Schema.String,
});

export type RunRecord = typeof RunRecord.Type;

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { reason: Schema.String }) {}

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { what: Schema.String }) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", { problems: Schema.Array(Schema.String) }) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", { reason: Schema.String }) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { reason: Schema.String }) {}

export class Upstream extends Schema.TaggedError<Upstream>()("Upstream", { service: Schema.String, detail: Schema.String }) {}

export type HttpFailure = Unauthorized | NotFound | BadRequest | Conflict | RateLimited | Upstream;

export class Owner extends Context.Service<Owner, { readonly id: OwnerId; readonly method: "access-user" | "bearer"; readonly email: string | null }>()("terrarium/Owner") {}

export class Clock extends Context.Service<Clock, { readonly nowMs: Effect.Effect<number> }>()("terrarium/Clock") {}

export class Ids extends Context.Service<Ids, { readonly runId: Effect.Effect<RunId>; readonly loopId: Effect.Effect<LoopId>; readonly nonce: Effect.Effect<string> }>()("terrarium/Ids") {}

export const AdmitInput = Schema.Struct({
  task: Schema.String,
  channel: Schema.NullOr(Schema.String),
  idempotencyKey: Schema.String,
});

export type AdmitInput = typeof AdmitInput.Type;

export class Runs extends Context.Service<Runs, {
  readonly admit: (input: AdmitInput) => Effect.Effect<RunRecord, BadRequest | Conflict | RateLimited | Upstream, Owner>;
  readonly get: (runId: RunId) => Effect.Effect<RunRecord, NotFound | Upstream, Owner>;
  readonly cancel: (runId: RunId) => Effect.Effect<RunRecord, NotFound | Upstream, Owner>;
  readonly list: (channel: string | null, limit: number) => Effect.Effect<ReadonlyArray<RunRecord>, Upstream, Owner>;
}>()("terrarium/Runs") {}
