import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect, Option, Schema } from "effect";

const Config = Schema.fromJsonString(Schema.Struct({ cloudUrl: Schema.String }));

export const CallbackEvent = Schema.Struct({ eventId: Schema.String, runId: Schema.String, status: Schema.String, contractStatus: Schema.String, summary: Schema.NullOr(Schema.String) });

export type CallbackEvent = typeof CallbackEvent.Type;

const Claimed = Schema.fromJsonString(Schema.Struct({ events: Schema.Array(CallbackEvent) }));

export class CloudError extends Schema.TaggedError<CloudError>()("CloudError", { detail: Schema.String }) {}

export const cloudUrl = () =>
  process.env.TERRARIUM_URL ?? Schema.decodeUnknownOption(Config)(readFileSync(join(homedir(), ".terrarium", "effect-config.json"), { encoding: "utf8", flag: "a+" })).pipe(Option.match({ onNone: () => "", onSome: (config) => config.cloudUrl }));

const authHeader = (url: string) => {
  const bearer = process.env.TERRARIUM_TOKEN ?? "";

  if (bearer.length > 0) return Effect.succeed({ authorization: `Bearer ${bearer}` });

  return Effect.callback<{ readonly "cf-access-token": string }, CloudError>((resume) => {
    execFile("cloudflared", ["access", "token", `-app=${url}`], (error, stdout) =>
      resume(error === null ? Effect.succeed({ "cf-access-token": stdout.trim() }) : Effect.fail(new CloudError({ detail: error.message }))));
  });
};

const RunStatus = Schema.fromJsonString(Schema.Struct({ runId: Schema.String, terminal: Schema.NullOr(Schema.Struct({ status: Schema.String, contractStatus: Schema.String, summary: Schema.NullOr(Schema.String) })) }));

export const terminalOf = (url: string, runId: string) => Effect.gen(function* () {
  const headers = yield* authHeader(url);
  const response = yield* Effect.tryPromise({ try: () => fetch(new URL(`/api/runs/${encodeURIComponent(runId)}/status`, url), { headers }), catch: (cause) => new CloudError({ detail: String(cause) }) });
  const text = yield* Effect.tryPromise({ try: () => response.text(), catch: (cause) => new CloudError({ detail: String(cause) }) });
  const status = yield* Schema.decodeUnknownEffect(RunStatus)(text).pipe(Effect.mapError((error) => new CloudError({ detail: error.message })));

  return status.terminal === null ? Option.none<CallbackEvent>() : Option.some<CallbackEvent>({ eventId: `evt_${runId}`, runId, ...status.terminal });
});

export const runIdsIn = (text: string) => text.match(/ter_[a-z0-9]{6,12}_[a-f0-9]{12}/g) ?? [];

export const followUp = (event: CallbackEvent) =>
  `Terrarium run ${event.runId} finished: ${event.status} (receipt ${event.contractStatus}).\n\n${event.summary ?? "(no summary)"}\n\nRead the result, integrate it if appropriate, and continue.`;
