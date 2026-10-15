import { Option, Schema } from "effect";

import type { ModelAnswer } from "./model-route.ts";

export const ActivityEvent = Schema.Struct({
  at: Schema.Number,
  kind: Schema.Literals(["tool", "text"]),
  detail: Schema.String,
});

export type ActivityEvent = typeof ActivityEvent.Type;

export const MAX_EVENTS = 200;

const MAX_DETAIL = 240;

const clip = (text: string) => (text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL - 1)}…`);

const SECRETISH = /(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*\S+/gi;

const RECEIPT = new RegExp("TERRARIUM_RESULT=\\S*", "g");

const scrub = (text: string) => text.replace(SECRETISH, "$1=<redacted>").replace(RECEIPT, "TERRARIUM_RESULT=<receipt>");

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const ArgsWithCommand = Schema.fromJsonString(Schema.Struct({ command: Schema.optionalKey(Schema.String), path: Schema.optionalKey(Schema.String) }));

const argSummary = (raw: string): string =>
  Option.match(Schema.decodeUnknownOption(ArgsWithCommand)(raw), { onNone: () => oneLine(raw), onSome: (args) => oneLine(args.command ?? args.path ?? raw) });

export const eventsOf = (answer: ModelAnswer, at: number): ReadonlyArray<ActivityEvent> => {
  const tools = answer.toolCalls.map((call): ActivityEvent => ({ at, kind: "tool", detail: clip(scrub(`${call.function.name} ${argSummary(call.function.arguments)}`)) }));
  const text = oneLine(answer.content);

  return text.length === 0 ? tools : [...tools, { at, kind: "text", detail: clip(scrub(text)) }];
};

export const appendCapped = (log: ReadonlyArray<ActivityEvent>, more: ReadonlyArray<ActivityEvent>): ReadonlyArray<ActivityEvent> => [...log, ...more].slice(-MAX_EVENTS);

export const since = (log: ReadonlyArray<ActivityEvent>, afterMs: number): ReadonlyArray<ActivityEvent> => log.filter((event) => event.at > afterMs);

export const widgetLines = (runId: string, log: ReadonlyArray<ActivityEvent>, startedMs: number, rows = 4): ReadonlyArray<string> => {
  const recent = log.slice(-rows).map((event) => `  ${event.kind === "tool" ? "▸" : "·"} +${Math.max(0, Math.round((event.at - startedMs) / 1000))}s ${event.detail}`);

  return [`terrarium ${runId} · ${log.length} steps`, ...recent];
};
