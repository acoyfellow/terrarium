import { Effect } from "effect";

import { ack, claim, cloudUrl, followUp, runIdsIn } from "./cloud.ts";

interface ToolResultEvent {
  readonly toolName: string;
  readonly input: { readonly background?: boolean };
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

interface Context {
  readonly sessionManager: { readonly getSessionId: () => string };
}

interface Pi {
  readonly on: (event: "tool_result", handler: (event: ToolResultEvent, ctx: Context) => void) => void;
  readonly sendUserMessage: (content: string, options: { readonly deliverAs: "followUp" }) => void;
}

const POLL_MS = 15_000;

const isSpawnTool = (name: string) => name === "terrarium_spawn" || name.endsWith("_terrarium_spawn");

const awaitRun = (pi: Pi, url: string, subscriberId: string, runId: string) => {
  const sweep = Effect.gen(function* () {
    const events = yield* claim(url, subscriberId);
    const event = events.find((candidate) => candidate.runId === runId);

    if (event === undefined) return false;

    yield* Effect.sync(() => pi.sendUserMessage(followUp(event), { deliverAs: "followUp" }));
    yield* ack(url, subscriberId, event.eventId);

    return true;
  }).pipe(Effect.catch(() => Effect.succeed(false)));

  const loop: Effect.Effect<void> = Effect.sleep(POLL_MS).pipe(Effect.andThen(sweep), Effect.flatMap((done) => (done ? Effect.void : loop)));

  Effect.runFork(loop);
};

export default function terrariumEffect(pi: Pi) {
  pi.on("tool_result", (event, ctx) => {
    if (!isSpawnTool(event.toolName) || event.input.background !== true) return;

    const url = cloudUrl();
    const text = event.content.map((item) => item.text ?? "").join("\n");

    if (url.length === 0) return;

    new Set(runIdsIn(text)).forEach((runId) => awaitRun(pi, url, `pi-${ctx.sessionManager.getSessionId()}`, runId));
  });
}
