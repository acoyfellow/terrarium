import { Effect, Option } from "effect";

import { cloudUrl, followUp, runIdsIn, terminalOf } from "./cloud.ts";

interface ToolResultEvent {
  readonly toolName: string;
  readonly input: { readonly background?: boolean };
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

interface Context {
  readonly sessionManager: { readonly getSessionId: () => string };
}

interface Pi {
  readonly on: (event: "tool_result", handler: (event: ToolResultEvent) => void) => void;
  readonly sendUserMessage: (content: string, options: { readonly deliverAs: "followUp" }) => void;
}

const POLL_MS = 15_000;

const isSpawnTool = (name: string) => name === "terrarium_spawn" || name.endsWith("_terrarium_spawn");

const awaitRun = (pi: Pi, url: string, runId: string) => {
  const sweep = terminalOf(url, runId).pipe(
    Effect.tap(Option.match({ onNone: () => Effect.void, onSome: (event) => Effect.sync(() => pi.sendUserMessage(followUp(event), { deliverAs: "followUp" })) })),
    Effect.map(Option.isSome),
    Effect.catch(() => Effect.succeed(false)),
  );

  const loop: Effect.Effect<void> = Effect.sleep(POLL_MS).pipe(Effect.andThen(sweep), Effect.flatMap((done) => (done ? Effect.void : loop)));

  Effect.runFork(loop);
};

export default function terrariumEffect(pi: Pi) {
  pi.on("tool_result", (event) => {
    if (!isSpawnTool(event.toolName) || event.input.background !== true) return;

    const url = cloudUrl();
    const text = event.content.map((item) => item.text ?? "").join("\n");

    if (url.length === 0) return;

    new Set(runIdsIn(text)).forEach((runId) => awaitRun(pi, url, runId));
  });
}
