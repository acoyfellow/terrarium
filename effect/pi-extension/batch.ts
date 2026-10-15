import { Duration, Effect, Schema } from "effect";

import { CloudError, authedGet, authedPost, authedPostEmpty } from "./cloud.ts";

export const MAX_BATCH = 8;

export const BATCH_POLL_MS = 5000;

export const BATCH_DEADLINE_MS = 15 * 60 * 1000;

export const BatchInput = Schema.Struct({
  tasks: Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BATCH)),
  proof: Schema.optionalKey(Schema.String),
  channel: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.Literals(["all", "first"])),
});

export type BatchInput = typeof BatchInput.Type;

const Admitted = Schema.fromJsonString(Schema.Struct({ runId: Schema.String }));

const Status = Schema.fromJsonString(Schema.Struct({
  runId: Schema.String,
  terminal: Schema.NullOr(Schema.Struct({ status: Schema.String, provenance: Schema.String, summary: Schema.NullOr(Schema.String) })),
}));

export interface BatchRun {
  readonly index: number;
  readonly runId: string;
  readonly status: string;
  readonly summary: string | null;
}

export interface BatchReport {
  readonly mode: "all" | "first";
  readonly winner: BatchRun | null;
  readonly runs: ReadonlyArray<BatchRun>;
  readonly passed: number;
  readonly seconds: number;
}

export interface BatchCalls {
  readonly admit: (task: string, index: number) => Effect.Effect<string, CloudError>;
  readonly status: (runId: string) => Effect.Effect<BatchRun["status"] | null, CloudError>;
  readonly summary: (runId: string) => Effect.Effect<string | null, CloudError>;
  readonly cancel: (runId: string) => Effect.Effect<void, CloudError>;
}

export const settled = (status: string | null) => status !== null && status !== "running";

export const decideBatch = (mode: "all" | "first", statuses: ReadonlyArray<string | null>): "wait" | "done" => {
  if (mode === "first" && statuses.some((status) => status === "done")) return "done";

  return statuses.every(settled) ? "done" : "wait";
};

export const runBatch = (input: BatchInput, calls: BatchCalls, pollMs = BATCH_POLL_MS, deadlineMs = BATCH_DEADLINE_MS): Effect.Effect<BatchReport, CloudError> =>
  Effect.gen(function* () {
    const mode = input.mode ?? "all";
    const startedMs = Date.now();

    const runIds = yield* Effect.forEach(input.tasks, (task, index) => calls.admit(task, index), { concurrency: "unbounded" });
    const poll = Effect.forEach(runIds, (runId) => calls.status(runId).pipe(Effect.orElseSucceed(() => null)), { concurrency: "unbounded" });

    const step = (statuses: ReadonlyArray<string | null>): Effect.Effect<ReadonlyArray<string | null>, CloudError> =>
      decideBatch(mode, statuses) === "done" || Date.now() - startedMs > deadlineMs ? Effect.succeed(statuses) : Effect.sleep(Duration.millis(pollMs)).pipe(Effect.andThen(poll), Effect.flatMap(step));

    const final = yield* poll.pipe(Effect.flatMap(step));
    const open = runIds.filter((_, index) => !settled(final[index] ?? null));

    if (mode === "first") yield* Effect.forEach(open, (runId) => Effect.ignore(calls.cancel(runId)), { concurrency: "unbounded", discard: true });

    const runs = yield* Effect.forEach(runIds, (runId, index) =>
      calls.summary(runId).pipe(Effect.orElseSucceed(() => null), Effect.map((summary): BatchRun => ({ index, runId, status: final[index] ?? "running", summary }))), { concurrency: "unbounded" });

    const winner = runs.find((run) => run.status === "done") ?? null;

    return { mode, winner, runs, passed: runs.filter((run) => run.status === "done").length, seconds: Math.round((Date.now() - startedMs) / 1000) };
  });

const decodeWith = <A>(schema: Schema.Decoder<A>, text: string) => Schema.decodeUnknownEffect(schema)(text).pipe(Effect.mapError((error) => new CloudError({ detail: `${error.message} :: ${text.slice(0, 200)}` })));

export const cloudBatchCalls = (url: string, input: BatchInput, batchId: string): BatchCalls => ({
  admit: (task, index) =>
    authedPost(url, "/api/runs", { task, proof: input.proof ?? null, channel: input.channel ?? "batch" }, { "idempotency-key": `batch.${batchId}.${index}` }).pipe(Effect.flatMap((text) => decodeWith(Admitted, text)), Effect.map((admitted) => admitted.runId)),
  status: (runId) => authedGet(url, `/api/runs/${encodeURIComponent(runId)}/status`).pipe(Effect.flatMap((text) => decodeWith(Status, text)), Effect.map((status) => status.terminal?.status ?? "running")),
  summary: (runId) => authedGet(url, `/api/runs/${encodeURIComponent(runId)}/status`).pipe(Effect.flatMap((text) => decodeWith(Status, text)), Effect.map((status) => status.terminal?.summary ?? null)),
  cancel: (runId) => authedPostEmpty(url, `/api/runs/${encodeURIComponent(runId)}/cancel`),
});

export const renderReport = (report: BatchReport): string =>
  [
    `terrarium_batch ${report.mode}: ${report.passed}/${report.runs.length} passed in ${report.seconds}s${report.winner === null ? "" : `; winner #${report.winner.index} ${report.winner.runId}`}`,
    ...report.runs.map((run) => `#${run.index} ${run.runId} ${run.status}${run.summary === null ? "" : ` :: ${run.summary.slice(0, 200)}`}`),
  ].join("\n");
