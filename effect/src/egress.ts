import type { ActivityEvent } from "./activity.ts";
import { Context, Effect } from "effect";

import { Upstream } from "./shared.ts";

export const OUTSIDE_TARGETS = ["https://example.com/", "https://api.cloudflare.com/client/v4/user", "https://registry.npmjs.org/", "http://example.com/"] as const;

const CURL_SECONDS = 8;

const curlLine = (url: string) => `printf 'reach %s %s\\n' '${url}' "$(curl -s -m ${CURL_SECONDS} -o /dev/null -w '%{http_code}' '${url}' || true)"`;

const MODEL_BODY = JSON.stringify({ messages: [{ role: "user", content: "Reply with: ok" }] });

const modelLine = (url: string) => `printf 'reach %s %s\\n' '${url}' "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '${MODEL_BODY}' '${url}' || true)"`;

const timedLine = (label: string, command: string) => `s=$(date +%s%N); ${command} >/dev/null 2>&1; echo ${label} $(( ($(date +%s%N) - s) / 1000000 ))`;

export const probeCommand = (modelHost: string) =>
  [
    ...OUTSIDE_TARGETS.map(curlLine),
    modelLine(`https://${modelHost}/_terrarium_model/v1/chat/completions`),
    timedLine("pistartms", "pi --version"),
    "env | cut -d= -f1 | grep -iE 'token|secret|key|auth|pass' | sed 's/^/envname /' || true",
  ].join("; ");

export interface ProbeReport {
  readonly reachable: Readonly<Record<string, string>>;
  readonly secretEnvNames: ReadonlyArray<string>;
  readonly piStartupMs: number | null;
}

export const parseProbe = (stdout: string): ProbeReport => {
  const lines = stdout.split("\n").map((line) => line.trim().split(" "));
  const reachable = Object.fromEntries(lines.filter(([kind, url]) => kind === "reach" && url !== undefined).map(([, url, code]) => [url, code === undefined || code.length === 0 ? "000" : code]));
  const secretEnvNames = lines.filter(([kind, name]) => kind === "envname" && name !== undefined).map(([, name]) => name ?? "");
  const piLine = lines.find(([kind]) => kind === "pistartms");

  return { reachable, secretEnvNames, piStartupMs: piLine?.[1] === undefined ? null : Number(piLine[1]) };
};

export interface ProbeBox {
  readonly exec: (command: string) => Promise<{ readonly stdout: string; readonly exitCode: number }>;
  readonly destroy: () => Promise<void>;
}

export class ProbeBoxes extends Context.Service<ProbeBoxes, { readonly fresh: () => ProbeBox; readonly modelHost: string; readonly activity: (runId: string, afterMs: number) => Promise<ReadonlyArray<ActivityEvent>> }>()("terrarium/ProbeBoxes") {}

const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (cause) => new Upstream({ service: "sandbox", detail: String(cause) }) });

export const runProbe = Effect.gen(function* () {
  const boxes = yield* ProbeBoxes;
  const box = boxes.fresh();
  const startedMs = Date.now();
  const result = yield* call(() => box.exec(probeCommand(boxes.modelHost))).pipe(Effect.ensuring(Effect.ignore(call(() => box.destroy()))));

  return { ok: true, exitCode: result.exitCode, totalMs: Date.now() - startedMs, ...parseProbe(result.stdout) };
});
