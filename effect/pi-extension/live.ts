import { Duration, Effect, Schema } from "effect";

import { authedGet } from "./cloud.ts";

export const LIVE_POLL_MS = 4000;

const Activity = Schema.fromJsonString(Schema.Struct({
  status: Schema.String,
  createdAt: Schema.String,
  events: Schema.Array(Schema.Struct({ at: Schema.Number, kind: Schema.String, detail: Schema.String })),
}));

type ActivityEvent = { readonly at: number; readonly kind: string; readonly detail: string };

export interface WidgetSink {
  readonly setWidget: (key: string, lines: ReadonlyArray<string> | undefined) => void;
}

export const renderLines = (runId: string, events: ReadonlyArray<ActivityEvent>, startedMs: number, rows = 4): ReadonlyArray<string> => [
  `terrarium ${runId} · ${events.length} steps`,
  ...events.slice(-rows).map((event) => `  ${event.kind === "tool" ? "▸" : "·"} +${Math.max(0, Math.round((event.at - startedMs) / 1000))}s ${event.detail.slice(0, 100)}`),
];

export const liveWidget = (url: string, runId: string, sink: WidgetSink, pollMs = LIVE_POLL_MS): Effect.Effect<void> => {
  const key = `terrarium-${runId}`;
  const seen: Array<ActivityEvent> = [];

  const tick = (afterMs: number): Effect.Effect<void> =>
    authedGet(url, `/api/runs/${encodeURIComponent(runId)}/activity?after=${afterMs}`).pipe(
      Effect.flatMap((text) => Schema.decodeUnknownEffect(Activity)(text)),
      Effect.flatMap((activity) => {
        seen.push(...activity.events);
        sink.setWidget(key, renderLines(runId, seen, Date.parse(activity.createdAt)));

        if (activity.status !== "running") return Effect.void;

        return Effect.sleep(Duration.millis(pollMs)).pipe(Effect.andThen(tick(seen.at(-1)?.at ?? afterMs)));
      }),
      Effect.catch(() => Effect.void),
    );

  return tick(0).pipe(Effect.ensuring(Effect.sync(() => sink.setWidget(key, undefined))));
};
