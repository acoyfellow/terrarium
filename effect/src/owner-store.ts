import { Effect, Schema } from "effect";

import { BadRequest, Conflict, NotFound, RateLimited, RunRecord, RunId, Provenance, TerminalStatus } from "./shared.ts";
import type { RunTerminal } from "./shared.ts";

export type SqlValue = string | number | null;

export interface SqlRow {
  readonly v?: SqlValue;
}

export interface Sql {
  readonly rows: (query: string, ...bindings: ReadonlyArray<SqlValue>) => ReadonlyArray<SqlRow>;
}

export const CallbackEvent = Schema.Struct({
  eventId: Schema.String,
  runId: RunId,
  status: TerminalStatus,
  provenance: Provenance,
  summary: Schema.NullOr(Schema.String),
  finishedAt: Schema.String,
});

export type CallbackEvent = typeof CallbackEvent.Type;

export interface AdmitReservation {
  readonly idempotencyKey: string;
  readonly request: string;
  readonly record: RunRecord;
  readonly nowMs: number;
  readonly maxLive: number;
  readonly perMinute: number;
}

export interface Admission {
  readonly record: RunRecord;
  readonly created: boolean;
}

export interface ClaimRequest {
  readonly subscriberId: string;
  readonly limit: number;
  readonly nowMs: number;
  readonly leaseMs: number;
}

export const StoreError = Schema.Union([BadRequest, Conflict, NotFound, RateLimited]);

export type StoreError = typeof StoreError.Type;

export type Reply<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: typeof StoreError.Encoded };

const RecordJson = Schema.fromJsonString(RunRecord);

const EventJson = Schema.fromJsonString(CallbackEvent);

const EventId = Schema.String.check(Schema.isPattern(/^evt_ter_[a-z0-9]{6,12}_[a-f0-9]{12}$/));

const encodeRecord = Schema.encodeSync(RecordJson);

const encodeEvent = Schema.encodeSync(EventJson);

const LEGACY_PROVENANCE = /"contractStatus":"(verified|missing|mismatch|malformed)"/;

const StoredText = Schema.String;

export const upgradeLegacy = (stored: string): string => stored.replace(LEGACY_PROVENANCE, (_, status: string) => `"provenance":"${status === "verified" ? "this-run" : status}"`);

const upgraded = (stored: SqlValue | undefined) => Schema.decodeUnknownEffect(StoredText)(stored).pipe(Effect.map(upgradeLegacy));

const decodeRecord = (stored: SqlValue | undefined) => upgraded(stored).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecordJson)));

const decodeEvent = (stored: SqlValue | undefined) => upgraded(stored).pipe(Effect.flatMap(Schema.decodeUnknownEffect(EventJson)));

const DDL = [
  "create table if not exists runs (run_id text primary key, created_ms integer not null, channel text, live integer not null, record text not null)",
  "create table if not exists idem (key text primary key, request text not null, run_id text not null)",
  "create table if not exists starts (run_id text primary key, first_ms integer not null, attempts integer not null)",
  "create table if not exists events (event_id text primary key, created_ms integer not null, lease_until integer not null default 0, lease_holder text, acked integer not null default 0, event text not null)",
];

export const migrate = (sql: Sql): void => {
  DDL.forEach((statement) => sql.rows(statement));
};

const single = (sql: Sql, query: string, ...bindings: ReadonlyArray<SqlValue>): SqlValue | undefined => sql.rows(query, ...bindings)[0]?.v;

const count = (sql: Sql, query: string, ...bindings: ReadonlyArray<SqlValue>): number => Number(single(sql, query, ...bindings) ?? 0);

const withStarts = (sql: Sql, record: RunRecord): RunRecord => {
  const attempts = single(sql, "select attempts as v from starts where run_id = ?", record.runId);

  return attempts === undefined ? record : { ...record, startAttempts: Number(attempts) };
};

export const getRun = (sql: Sql, runId: string): Effect.Effect<RunRecord, NotFound> => {
  const stored = single(sql, "select record as v from runs where run_id = ?", runId);

  return stored === undefined ? Effect.fail(new NotFound({ what: `run ${runId}` })) : Effect.orDie(decodeRecord(stored)).pipe(Effect.map((record) => withStarts(sql, record)));
};

export interface StartLease {
  readonly first: boolean;
  readonly attempts: number;
}

export const beginStart = (sql: Sql, runId: string, nowMs: number): Effect.Effect<StartLease, NotFound> =>
  getRun(sql, runId).pipe(Effect.map(() => {
    const attempts = Number(single(sql, "insert into starts (run_id, first_ms, attempts) values (?, ?, 1) on conflict(run_id) do update set attempts = attempts + 1 returning attempts as v", runId, nowMs));

    return { first: attempts === 1, attempts };
  }));

const reserveNew = (sql: Sql, reservation: AdmitReservation): Effect.Effect<Admission, RateLimited> => {
  const live = count(sql, "select count(*) as v from runs where live = 1");

  if (live >= reservation.maxLive) return Effect.fail(new RateLimited({ reason: `live run limit ${reservation.maxLive} reached` }));

  const recent = count(sql, "select count(*) as v from runs where created_ms > ?", reservation.nowMs - 60_000);

  if (recent >= reservation.perMinute) return Effect.fail(new RateLimited({ reason: `admission limit ${reservation.perMinute}/minute reached` }));

  const { record } = reservation;
  sql.rows("insert into runs (run_id, created_ms, channel, live, record) values (?, ?, ?, 1, ?)", record.runId, reservation.nowMs, record.channel, encodeRecord(record));
  sql.rows("insert into idem (key, request, run_id) values (?, ?, ?)", reservation.idempotencyKey, reservation.request, record.runId);

  return Effect.succeed({ record, created: true });
};

export const admitReserve = (sql: Sql, reservation: AdmitReservation): Effect.Effect<Admission, Conflict | RateLimited> => {
  const prior = sql.rows("select request || char(0) || run_id as v from idem where key = ?", reservation.idempotencyKey)[0]?.v;

  if (prior === undefined || prior === null) return reserveNew(sql, reservation);

  const [request, runId] = String(prior).split("\u0000");

  if (request !== reservation.request) return Effect.fail(new Conflict({ reason: "idempotency key reused with a different body" }));

  return getRun(sql, runId).pipe(Effect.orDie, Effect.map((record) => ({ record, created: false })));
};

const recordTerminal = (sql: Sql, record: RunRecord, terminal: RunTerminal, logs: string): RunRecord => {
  const finished = { ...record, terminal, logs };
  const event = { eventId: `evt_${record.runId}`, runId: record.runId, status: terminal.status, provenance: terminal.provenance, summary: terminal.summary, finishedAt: terminal.finishedAt };
  sql.rows("update runs set live = 0, record = ? where run_id = ?", encodeRecord(finished), record.runId);
  sql.rows("insert or ignore into events (event_id, created_ms, event) values (?, ?, ?)", event.eventId, Date.parse(terminal.finishedAt), encodeEvent(event));

  return finished;
};

export const finish = (sql: Sql, runId: string, terminal: RunTerminal, logs: string): Effect.Effect<RunRecord, NotFound> =>
  getRun(sql, runId).pipe(Effect.map((record) => (record.terminal === null ? recordTerminal(sql, record, terminal, logs) : record)));

export const listRuns = (sql: Sql, channel: string | null, limit: number): Effect.Effect<ReadonlyArray<RunRecord>> =>
  Effect.forEach(
    sql.rows("select record as v from runs where (? is null or channel = ?) order by created_ms desc, rowid desc limit ?", channel, channel, limit),
    (row) => Effect.orDie(decodeRecord(row.v)),
  );

export const claim = (sql: Sql, request: ClaimRequest): Effect.Effect<ReadonlyArray<CallbackEvent>> => {
  const rows = sql.rows(
    "update events set lease_until = ?, lease_holder = ? where event_id in (select event_id from events where acked = 0 and lease_until <= ? order by created_ms limit ?) returning event as v",
    request.nowMs + request.leaseMs,
    request.subscriberId,
    request.nowMs,
    request.limit,
  );

  return Effect.forEach(rows, (row) => Effect.orDie(decodeEvent(row.v)));
};

export const ack = (sql: Sql, subscriberId: string, eventId: string): Effect.Effect<string, BadRequest | NotFound> => {
  if (!Schema.is(EventId)(eventId) || subscriberId.length === 0) return Effect.fail(new BadRequest({ problems: ["ack needs a subscriberId and a well-formed eventId"] }));

  const acked = sql.rows("update events set acked = 1 where event_id = ? and acked = 0 returning event_id as v", eventId);

  return acked.length === 0 ? Effect.fail(new NotFound({ what: `event ${eventId}` })) : Effect.succeed(eventId);
};

const encodeStoreError = Schema.encodeSync(StoreError);

const decodeStoreError = Schema.decodeSync(StoreError);

export const toReply = <A>(effect: Effect.Effect<A, StoreError>): Reply<A> =>
  Effect.runSync(Effect.match(effect, {
    onFailure: (error): Reply<A> => ({ ok: false, error: encodeStoreError(error) }),
    onSuccess: (value): Reply<A> => ({ ok: true, value }),
  }));

export const fromReply = <A>(reply: Reply<A>): Effect.Effect<A, StoreError> => (reply.ok ? Effect.succeed(reply.value) : Effect.fail(decodeStoreError(reply.error)));
