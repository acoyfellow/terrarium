import { Effect } from "effect";

import { cloudUrl, followUp, runIdsIn, terminalOf } from "./cloud.ts";
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

interface Pi {
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

export default function terrariumEffect(pi: Pi) {
  const providerUrl = cloudUrl();

  if (providerUrl.length > 0) registerProvider(providerUrl);

  pi.on("tool_result", (event, ctx) => {
    if (!isSpawnTool(event.toolName) || event.input.background !== true) return;

    const url = cloudUrl();
    const text = event.content.map((item) => item.text ?? "").join("\n");

    if (url.length === 0) return;

    new Set(runIdsIn(text)).forEach((runId) => awaitRun(pi, url, runId, ctx?.ui));
  });
}
