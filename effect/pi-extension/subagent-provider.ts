import { Effect, Option, Schema } from "effect";

import { CloudError, authedGet, authedPost } from "./cloud.ts";

export const PROVIDER_NAME = "terrarium";

export const REGISTRY_KEY = "pi-subagents.external-job-providers.v1";

export type JobState = "queued" | "running" | "completed" | "failed" | "stopped" | "blocked";

export interface JobHandle {
  readonly providerJobId: string;
  readonly state: JobState;
  readonly handleUrl?: string;
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

export interface JobResult extends JobHandle {
  readonly output?: string;
}

const JobOptions = Schema.Struct({ proof: Schema.optionalKey(Schema.String), channel: Schema.optionalKey(Schema.String) });

export type JobOptions = typeof JobOptions.Type;

export const parseOptions = (raw: JobOptions): JobOptions => Option.getOrElse(Schema.decodeUnknownOption(JobOptions)(raw), () => ({}));

export interface StartInput {
  readonly prompt: string;
  readonly promptDigest: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly agent: string;
  readonly options: JobOptions;
}

const Admitted = Schema.fromJsonString(Schema.Struct({ runId: Schema.String }));

const Status = Schema.fromJsonString(Schema.Struct({
  runId: Schema.String,
  terminal: Schema.NullOr(Schema.Struct({ status: Schema.String, provenance: Schema.String, summary: Schema.NullOr(Schema.String) })),
}));

const Logs = Schema.fromJsonString(Schema.Struct({ logs: Schema.String }));

const STATE_BY_STATUS = new Map<string, JobState>([["done", "completed"], ["failed", "failed"], ["cancelled", "stopped"]]);

const decode = <A>(schema: Schema.Decoder<A>, text: string) => Schema.decodeUnknownEffect(schema)(text).pipe(Effect.mapError((error) => new CloudError({ detail: `${error.message} :: ${text.slice(0, 300)}` })));

export const admitBody = (input: StartInput) => {
  const proof = input.options.proof ?? null;
  const channel = input.options.channel ?? `pi-subagents:${input.agent}`;

  return { task: input.prompt, proof, channel };
};

const SAFE_KEY = new RegExp("[^A-Za-z0-9._~+/=-]", "g");

export const idempotencyKey = (input: StartInput) => `pi-subagents.${input.runId}.${input.stepIndex}.${input.promptDigest}`.replace(SAFE_KEY, "-").slice(0, 255);

export const handleOf = (url: string, status: typeof Status.Type): JobHandle => {
  const handleUrl = new URL(`/api/runs/${status.runId}/status`, url).toString();

  if (status.terminal === null) return { providerJobId: status.runId, state: "running", handleUrl };

  const state = STATE_BY_STATUS.get(status.terminal.status) ?? "failed";

  return state === "failed"
    ? { providerJobId: status.runId, state, handleUrl, failureCode: `terrarium_${status.terminal.provenance}`, failureMessage: (status.terminal.summary ?? `run ${status.terminal.status}`).slice(0, 4000) }
    : { providerJobId: status.runId, state, handleUrl };
};

const statusOf = (url: string, runId: string) => authedGet(url, `/api/runs/${encodeURIComponent(runId)}/status`).pipe(Effect.flatMap((text) => decode(Status, text)));

export const terrariumJobs = (url: string) => ({
  start: (input: StartInput) =>
    authedPost(url, "/api/runs", admitBody(input), { "idempotency-key": idempotencyKey(input) }).pipe(
      Effect.flatMap((text) => decode(Admitted, text)),
      Effect.map((admitted): JobHandle => ({ providerJobId: admitted.runId, state: "running", handleUrl: new URL(`/api/runs/${admitted.runId}/status`, url).toString() })),
    ),
  status: (runId: string) => statusOf(url, runId).pipe(Effect.map((status) => handleOf(url, status))),
  result: (runId: string) =>
    Effect.gen(function* () {
      const status = yield* statusOf(url, runId);
      const handle = handleOf(url, status);
      const logs = yield* authedGet(url, `/api/runs/${encodeURIComponent(runId)}/logs`).pipe(Effect.flatMap((text) => decode(Logs, text)), Effect.map((body) => body.logs), Effect.orElseSucceed(() => ""));
      const summary = status.terminal?.summary ?? "";
      const output = [summary.length > 0 ? `Summary: ${summary}` : "", `Terrarium run ${runId}: ${status.terminal?.status ?? "running"} (receipt ${status.terminal?.provenance ?? "pending"})`, logs.slice(-6000)].filter((part) => part.length > 0).join("\n\n");

      return { ...handle, output } satisfies JobResult;
    }),
});

export const providerFor = (url: string) => {
  const jobs = terrariumJobs(url);
  const run = <A>(effect: Effect.Effect<A, CloudError>) => Effect.runPromise(effect.pipe(Effect.mapError((error) => new Error(`terrarium: ${error.detail}`))));

  return {
    name: PROVIDER_NAME,
    start: (input: StartInput) => run(jobs.start({ ...input, options: parseOptions(input.options) })),
    status: (runId: string) => run(jobs.status(runId)),
    result: (runId: string) => run(jobs.result(runId)),
    reattach: (runId: string) => run(jobs.status(runId)),
  };
};
