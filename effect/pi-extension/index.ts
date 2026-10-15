import { Effect, Schema } from "effect";

import { cloudUrl, followUp, runIdsIn, terminalOf } from "./cloud.ts";
import { BatchInput, cloudBatchCalls, renderReport, runBatch } from "./batch.ts";
import { liveWidget } from "./live.ts";
import { registerProvider } from "./subagent-registry.ts";
import type { WidgetSink } from "./live.ts";
import { watchRun } from "./watch.ts";
import type { WatchOutcome } from "./watch.ts";

interface ToolResultEvent {
  readonly toolName: string;
  readonly input: { readonly background?: boolean };
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

interface HandlerContext {
  readonly ui?: WidgetSink;
}

interface BatchTool {
  readonly name: "terrarium_batch";
  readonly label: string;
  readonly description: string;
  readonly parameters: object;
  readonly execute: (toolCallId: string, params: BatchInput) => Promise<{ readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>; readonly details: { readonly winner: string | null; readonly passed: number; readonly runs: ReadonlyArray<string> } }>;
}

interface Pi {
  readonly registerTool: (tool: BatchTool) => void;
  readonly on: (event: "tool_result", handler: (event: ToolResultEvent, ctx?: HandlerContext) => void) => void;
  readonly sendUserMessage: (content: string, options: { readonly deliverAs: "followUp" }) => void;
}

const isSpawnTool = (name: string) => name === "terrarium_spawn" || name.endsWith("_terrarium_spawn");

const watching = new Set<string>();

const deliver = (pi: Pi, runId: string, outcome: WatchOutcome) =>
  Effect.sync(() => {
    watching.delete(runId);
    const message = outcome.kind === "finished" ? followUp(outcome.event) : `Terrarium stopped watching run ${runId}: ${outcome.reason}. Check it with terrarium_status.`;

    pi.sendUserMessage(message, { deliverAs: "followUp" });
  });

const awaitRun = (pi: Pi, url: string, runId: string, ui: WidgetSink | undefined) => {
  if (watching.has(runId)) return;

  watching.add(runId);
  Effect.runFork(watchRun(terminalOf(url, runId)).pipe(Effect.flatMap((outcome) => deliver(pi, runId, outcome))));

  if (ui !== undefined) Effect.runFork(liveWidget(url, runId, ui));
};

const BATCH_PARAMETERS = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8, description: "One Terrarium run per task, started in parallel." },
    proof: { type: "string", description: "Shell command run in each box after its agent; exit 0 means that run passed." },
    channel: { type: "string" },
    mode: { type: "string", enum: ["all", "first"], description: "all waits for every run; first returns when one run passes and cancels the rest." },
  },
};

const batchTool = (url: string): BatchTool => ({
  name: "terrarium_batch",
  label: "Terrarium batch",
  description: "Start up to 8 Terrarium runs in parallel and wait. mode all returns every result; mode first returns the first run that passes its proof and cancels the others. Codemode scripts can call it as tools.terrarium_batch.",
  parameters: BATCH_PARAMETERS,
  execute: (toolCallId, params) =>
    Effect.runPromise(
      Schema.decodeUnknownEffect(BatchInput)(params).pipe(
        Effect.mapError((error) => new Error(`terrarium_batch: ${error.message}`)),
        Effect.flatMap((input) => runBatch(input, cloudBatchCalls(url, input, toolCallId.replace(new RegExp("[^A-Za-z0-9._~+/=-]", "g"), "-").slice(0, 120))).pipe(Effect.mapError((error) => new Error(`terrarium_batch: ${error.detail}`)))),
        Effect.map((report) => ({ content: [{ type: "text" as const, text: renderReport(report) }], details: { winner: report.winner?.runId ?? null, passed: report.passed, runs: report.runs.map((run) => run.runId) } })),
      ),
    ),
});

export default function terrariumEffect(pi: Pi) {
  const providerUrl = cloudUrl();

  if (providerUrl.length > 0) registerProvider(providerUrl);

  if (providerUrl.length > 0) pi.registerTool(batchTool(providerUrl));

  pi.on("tool_result", (event, ctx) => {
    if (!isSpawnTool(event.toolName) || event.input.background !== true) return;

    const url = cloudUrl();
    const text = event.content.map((item) => item.text ?? "").join("\n");

    if (url.length === 0) return;

    new Set(runIdsIn(text)).forEach((runId) => awaitRun(pi, url, runId, ctx?.ui));
  });
}
