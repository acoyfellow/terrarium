import { Context, Effect, Layer, Schema } from "effect";

import { CallbackEvent } from "../owner-store.ts";
import { ProofResult, Provenance, NotFound, RunContract, TerminalStatus, Unauthorized, Upstream } from "../shared.ts";

export class TokenSource extends Context.Service<TokenSource, { readonly header: Effect.Effect<{ readonly name: string; readonly value: string }, Unauthorized> }>()("terrarium/client/TokenSource") {}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type ClientError = Unauthorized | NotFound | Upstream;

const Whoami = Schema.Struct({ ok: Schema.Boolean, method: Schema.String, owner: Schema.String, email: Schema.optional(Schema.String) });

const Admitted = Schema.Struct({ runId: Schema.String, contract: RunContract });

const Terminal = Schema.Struct({ status: TerminalStatus, provenance: Provenance, proof: Schema.optionalKey(Schema.NullOr(ProofResult)), summary: Schema.NullOr(Schema.String), exitCode: Schema.NullOr(Schema.Int), finishedAt: Schema.String });

export const RunView = Schema.Struct({ runId: Schema.String, channel: Schema.NullOr(Schema.String), createdAt: Schema.String, status: Schema.String, terminal: Schema.NullOr(Terminal) });

export type RunView = typeof RunView.Type;

const RunList = Schema.Struct({ runs: Schema.Array(RunView) });

const Logs = Schema.Struct({ runId: Schema.String, logs: Schema.String });

const Claimed = Schema.Struct({ events: Schema.Array(CallbackEvent) });

const Acked = Schema.Struct({ eventId: Schema.String });

const Contract = Schema.Struct({ goal: Schema.String, task: Schema.String, expect: Schema.String, maxAttempts: Schema.Int });

const LoopStarted = Schema.Struct({ loopId: Schema.String, contract: Contract });

const LoopView = Schema.Struct({ loopId: Schema.String, contract: Contract, createdAt: Schema.String, status: Schema.String, output: Schema.Json, error: Schema.NullOr(Schema.Struct({ name: Schema.String, message: Schema.String })) });

const LoopList = Schema.Struct({ loops: Schema.Array(LoopView) });

export interface ListQuery {
  readonly channel?: string;
  readonly status?: string;
  readonly limit?: number;
}

export interface LoopInput {
  readonly goal: string;
  readonly task: string;
  readonly expect?: string;
  readonly proof?: string;
  readonly maxAttempts?: number;
}

export class TerrariumClient extends Context.Service<TerrariumClient, {
  readonly whoami: Effect.Effect<typeof Whoami.Type, ClientError>;
  readonly spawn: (task: string, channel?: string, proof?: string) => Effect.Effect<typeof Admitted.Type, ClientError>;
  readonly list: (query: ListQuery) => Effect.Effect<typeof RunList.Type, ClientError>;
  readonly status: (runId: string) => Effect.Effect<RunView, ClientError>;
  readonly logs: (runId: string) => Effect.Effect<typeof Logs.Type, ClientError>;
  readonly cancel: (runId: string) => Effect.Effect<RunView, ClientError>;
  readonly claim: (subscriberId: string, limit: number) => Effect.Effect<typeof Claimed.Type, ClientError>;
  readonly ack: (subscriberId: string, eventId: string) => Effect.Effect<typeof Acked.Type, ClientError>;
  readonly startLoop: (input: LoopInput) => Effect.Effect<typeof LoopStarted.Type, ClientError>;
  readonly loops: Effect.Effect<typeof LoopList.Type, ClientError>;
  readonly loop: (loopId: string) => Effect.Effect<typeof LoopView.Type, ClientError>;
}>()("terrarium/client/TerrariumClient") {}

const failureFor = (response: Response, path: string, body: string): ClientError => {
  if (response.status === 401 || response.status === 403) return new Unauthorized({ reason: body });

  if (response.status === 404) return new NotFound({ what: path });

  return new Upstream({ service: "terrarium", detail: `${response.status} ${body}` });
};

export const TerrariumClientLive = (baseUrl: string, fetcher: Fetch = fetch) =>
  Layer.effect(TerrariumClient, Effect.gen(function* () {
    const tokens = yield* TokenSource;
    const upstream = (cause: unknown) => new Upstream({ service: "terrarium", detail: String(cause) });

    const call = <S extends Schema.Decoder<unknown>>(schema: S, method: string, path: string, body?: string, headers?: HeadersInit) => Effect.gen(function* () {
      const auth = yield* tokens.header;

      const response = yield* Effect.tryPromise({
        try: () => fetcher(new URL(path, baseUrl).toString(), { method, headers: { ...headers, [auth.name]: auth.value, "content-type": "application/json" }, body }),
        catch: upstream,
      });

      const text = yield* Effect.tryPromise({ try: () => response.text(), catch: upstream });

      if (!response.ok) return yield* Effect.fail(failureFor(response, path, text));

      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(upstream));
    });

    const runPath = (runId: string, action: string) => `/api/runs/${encodeURIComponent(runId)}/${action}`;

    const query = (input: ListQuery) => {
      const params = new URLSearchParams();
      const entries: ReadonlyArray<readonly [string, string | undefined]> = [["channel", input.channel], ["status", input.status], ["limit", input.limit?.toString()]];

      entries.forEach(([key, value]) => value === undefined || params.set(key, value));

      return params.toString();
    };

    return TerrariumClient.of({
      whoami: call(Whoami, "GET", "/api/whoami"),
      spawn: (task, channel, proof) => call(Admitted, "POST", "/api/runs", JSON.stringify({ task, channel: channel ?? null, proof: proof ?? null }), { "idempotency-key": crypto.randomUUID() }),
      list: (input) => call(RunList, "GET", `/api/runs?${query(input)}`),
      status: (runId) => call(RunView, "GET", runPath(runId, "status")),
      logs: (runId) => call(Logs, "GET", runPath(runId, "logs")),
      cancel: (runId) => call(RunView, "POST", runPath(runId, "cancel")),
      claim: (subscriberId, limit) => call(Claimed, "POST", "/claim", JSON.stringify({ subscriberId, limit })),
      ack: (subscriberId, eventId) => call(Acked, "POST", "/ack", JSON.stringify({ subscriberId, eventId })),
      startLoop: (input) => call(LoopStarted, "POST", "/api/loops", JSON.stringify({ maxAttempts: 3, ...input })),
      loops: call(LoopList, "GET", "/api/loops"),
      loop: (loopId) => call(LoopView, "GET", `/api/loops/${encodeURIComponent(loopId)}`),
    });
  }));
