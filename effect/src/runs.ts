import { Context, Effect, Layer, Schema } from "effect";

import { fromReply } from "./owner-store.ts";
import type { Admission, AdmitReservation, CallbackEvent, ClaimRequest, Reply, StoreError } from "./owner-store.ts";
import { BadRequest, Clock, Ids, NotFound, Owner, Runs, Upstream } from "./shared.ts";
import type { Conflict, OwnerId, RateLimited, RunContract, RunId, RunRecord, RunTerminal } from "./shared.ts";

export const RunParams = Schema.Struct({ ownerId: Schema.String, runId: Schema.String, task: Schema.String, contract: Schema.Struct({ runId: Schema.String, taskFingerprint: Schema.String, nonce: Schema.String }) });

export type RunParams = typeof RunParams.Type;

export interface OwnerStore {
  readonly admitReserve: (reservation: AdmitReservation) => Effect.Effect<Admission, StoreError | Upstream>;
  readonly get: (runId: string) => Effect.Effect<RunRecord, StoreError | Upstream>;
  readonly finish: (runId: string, terminal: RunTerminal, logs: string) => Effect.Effect<RunRecord, StoreError | Upstream>;
  readonly list: (channel: string | null, limit: number) => Effect.Effect<ReadonlyArray<RunRecord>, StoreError | Upstream>;
  readonly claim: (request: ClaimRequest) => Effect.Effect<ReadonlyArray<CallbackEvent>, StoreError | Upstream>;
  readonly ack: (subscriberId: string, eventId: string) => Effect.Effect<string, StoreError | Upstream>;
}

export class OwnerStores extends Context.Service<OwnerStores, { readonly forOwner: (ownerId: OwnerId) => OwnerStore }>()("terrarium/OwnerStores") {}

export class RunWorkflows extends Context.Service<RunWorkflows, {
  readonly start: (params: RunParams) => Effect.Effect<void, Upstream>;
  readonly stop: (runId: RunId) => Effect.Effect<void, Upstream>;
}>()("terrarium/RunWorkflows") {}

export const RunLimits = Context.Reference("terrarium/RunLimits", { defaultValue: () => ({ maxLive: 8, perMinute: 30, leaseMs: 60_000 }) });

export class Callbacks extends Context.Service<Callbacks, {
  readonly claim: (subscriberId: string, limit: number) => Effect.Effect<ReadonlyArray<CallbackEvent>, BadRequest | Upstream, Owner>;
  readonly ack: (subscriberId: string, eventId: string) => Effect.Effect<string, BadRequest | NotFound | Upstream, Owner>;
}>()("terrarium/Callbacks") {}

const unexpected = (error: StoreError): Upstream => new Upstream({ service: "owner", detail: `unexpected ${error._tag}` });

const notFoundOnly = <A>(effect: Effect.Effect<A, StoreError | Upstream>): Effect.Effect<A, NotFound | Upstream> =>
  effect.pipe(Effect.catchTags({ BadRequest: (error) => Effect.fail(unexpected(error)), Conflict: (error) => Effect.fail(unexpected(error)), RateLimited: (error) => Effect.fail(unexpected(error)) }));

const admissionOnly = <A>(effect: Effect.Effect<A, StoreError | Upstream>): Effect.Effect<A, Conflict | RateLimited | Upstream> =>
  effect.pipe(Effect.catchTags({ BadRequest: (error) => Effect.fail(unexpected(error)), NotFound: (error) => Effect.fail(unexpected(error)) }));

const noStoreError = <A>(effect: Effect.Effect<A, StoreError | Upstream>): Effect.Effect<A, Upstream> => effect.pipe(Effect.catchTags({ BadRequest: (error) => Effect.fail(unexpected(error)), Conflict: (error) => Effect.fail(unexpected(error)), NotFound: (error) => Effect.fail(unexpected(error)), RateLimited: (error) => Effect.fail(unexpected(error)) }));

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256 = (text: string): Effect.Effect<string> => Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(Effect.map(hex));

const ownerStoreFrom = (stores: typeof OwnerStores.Service) => Effect.map(Owner, (owner) => stores.forOwner(owner.id));

const isoFrom = (clock: typeof Clock.Service) => clock.nowMs.pipe(Effect.map((ms) => new Date(ms).toISOString()));

const failStart = (nowIso: Effect.Effect<string>, store: OwnerStore, record: RunRecord, error: Upstream) =>
  nowIso.pipe(
    Effect.flatMap((finishedAt) => store.finish(record.runId, { status: "failed", contractStatus: "missing", summary: null, exitCode: null, finishedAt }, error.detail)),
    Effect.ignore,
    Effect.andThen(Effect.fail(error)),
  );

export const RunsLive = Layer.effect(Runs, Effect.gen(function* () {
  const clock = yield* Clock;
  const ids = yield* Ids;
  const workflows = yield* RunWorkflows;
  const ownerStore = ownerStoreFrom(yield* OwnerStores);
  const nowIso = isoFrom(clock);

  const admit = Effect.fn("Runs.admit")(function* (input: { readonly task: string; readonly channel: string | null; readonly idempotencyKey: string }) {
    if (input.task.trim().length === 0) return yield* new BadRequest({ problems: ["task must not be empty"] });

    const owner = yield* Owner;
    const store = yield* ownerStore;
    const limits = yield* RunLimits;
    const runId = yield* ids.runId;
    const nowMs = yield* clock.nowMs;
    const contract: RunContract = { runId, taskFingerprint: yield* sha256(input.task), nonce: yield* ids.nonce };
    const record: RunRecord = { runId, ownerId: owner.id, task: input.task, channel: input.channel, contract, createdAt: new Date(nowMs).toISOString(), terminal: null, logs: "" };
    const request = yield* sha256(JSON.stringify([input.task, input.channel]));
    const admission = yield* admissionOnly(store.admitReserve({ idempotencyKey: input.idempotencyKey, request, record, nowMs, maxLive: limits.maxLive, perMinute: limits.perMinute }));

    if (!admission.created) return admission.record;

    yield* workflows.start({ ownerId: owner.id, runId, task: input.task, contract }).pipe(Effect.catch((error) => failStart(nowIso, store, record, error)));

    return admission.record;
  });

  const get = (runId: RunId) => ownerStore.pipe(Effect.flatMap((store) => notFoundOnly(store.get(runId))));

  const cancel = (runId: RunId) => Effect.gen(function* () {
    const store = yield* ownerStore;
    const record = yield* notFoundOnly(store.get(runId));

    if (record.terminal !== null) return record;

    const finishedAt = yield* nowIso;
    const cancelled = yield* notFoundOnly(store.finish(runId, { status: "cancelled", contractStatus: "missing", summary: null, exitCode: null, finishedAt }, record.logs));
    yield* workflows.stop(runId);

    return cancelled;
  });

  const list = (channel: string | null, limit: number) => ownerStore.pipe(Effect.flatMap((store) => noStoreError(store.list(channel, Math.max(1, Math.min(limit, 200))))));

  return Runs.of({ admit, get, cancel, list });
}));

export const CallbacksLive = Layer.effect(Callbacks, Effect.gen(function* () {
  const clock = yield* Clock;
  const ownerStore = ownerStoreFrom(yield* OwnerStores);

  const claim = (subscriberId: string, limit: number) => Effect.gen(function* () {
    if (subscriberId.length === 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) return yield* new BadRequest({ problems: ["claim needs a subscriberId and limit 1..100"] });

    const store = yield* ownerStore;
    const limits = yield* RunLimits;

    return yield* noStoreError(store.claim({ subscriberId, limit, nowMs: yield* clock.nowMs, leaseMs: limits.leaseMs }));
  });

  const ack = (subscriberId: string, eventId: string) =>
    ownerStore.pipe(
      Effect.flatMap((store) => store.ack(subscriberId, eventId)),
      Effect.catchTags({ Conflict: (error) => Effect.fail(unexpected(error)), RateLimited: (error) => Effect.fail(unexpected(error)) }),
    );

  return Callbacks.of({ claim, ack });
}));

export interface OwnerRpc {
  readonly admitReserve: (reservation: AdmitReservation) => Promise<Reply<Admission>>;
  readonly get: (runId: string) => Promise<Reply<RunRecord>>;
  readonly finish: (runId: string, terminal: RunTerminal, logs: string) => Promise<Reply<RunRecord>>;
  readonly list: (channel: string | null, limit: number) => Promise<Reply<ReadonlyArray<RunRecord>>>;
  readonly claim: (request: ClaimRequest) => Promise<Reply<ReadonlyArray<CallbackEvent>>>;
  readonly ack: (subscriberId: string, eventId: string) => Promise<Reply<string>>;
}

export interface RunsEnv {
  readonly OWNER: { readonly getByName: (name: string) => OwnerRpc };
  readonly RUN_WORKFLOW: {
    readonly create: (options: { readonly id: string; readonly params: RunParams }) => Promise<{ readonly id: string }>;
    readonly get: (id: string) => Promise<{ readonly terminate: () => Promise<void> }>;
  };
}

const rpc = <A>(call: () => Promise<Reply<A>>): Effect.Effect<A, StoreError | Upstream> =>
  Effect.tryPromise({ try: call, catch: (cause) => new Upstream({ service: "owner", detail: String(cause) }) }).pipe(Effect.flatMap(fromReply));

export const ownerStoreOf = (env: RunsEnv, ownerId: string): OwnerStore => {
  const stub = env.OWNER.getByName(ownerId);

  return {
    admitReserve: (reservation) => rpc(() => stub.admitReserve(reservation)),
    get: (runId) => rpc(() => stub.get(runId)),
    finish: (runId, terminal, logs) => rpc(() => stub.finish(runId, terminal, logs)),
    list: (channel, limit) => rpc(() => stub.list(channel, limit)),
    claim: (request) => rpc(() => stub.claim(request)),
    ack: (subscriberId, eventId) => rpc(() => stub.ack(subscriberId, eventId)),
  };
};

const workflowCall = <A>(call: () => Promise<A>): Effect.Effect<void, Upstream> =>
  Effect.tryPromise({ try: call, catch: (cause) => new Upstream({ service: "workflow", detail: String(cause) }) }).pipe(Effect.asVoid);

export const cloudflareLayer = (env: RunsEnv) => Layer.mergeAll(
  Layer.succeed(OwnerStores, OwnerStores.of({ forOwner: (ownerId) => ownerStoreOf(env, ownerId) })),
  Layer.succeed(RunWorkflows, RunWorkflows.of({
    start: (params) => workflowCall(() => env.RUN_WORKFLOW.create({ id: params.runId, params })),
    stop: (runId) => workflowCall(() => env.RUN_WORKFLOW.get(runId).then((instance) => instance.terminate())),
  })),
);
