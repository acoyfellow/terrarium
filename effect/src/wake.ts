import { Schema } from "effect";

const Duration = Schema.String.check(Schema.isPattern(/^\d{1,4} (second|seconds|minute|minutes|hour|hours|day|days)$/));

export const Wake = Schema.Union([
  Schema.Struct({ on: Schema.Literal("event"), timeout: Schema.optionalKey(Duration) }),
  Schema.Struct({ every: Duration }),
]);

export type Wake = typeof Wake.Type;

export const WAKE_EVENT = "wake";

export const WakePayload = Schema.Struct({ source: Schema.String, note: Schema.optionalKey(Schema.String) });

export type WakePayload = typeof WakePayload.Type;

export const MAX_NOTE = 2000;

const UNIT_MS = new Map([["second", 1000], ["minute", 60_000], ["hour", 3_600_000], ["day", 86_400_000]]);

export const durationMs = (text: string): number => {
  const [amount, unit] = text.split(" ");

  return Number(amount) * (UNIT_MS.get(unit.replace(/s$/, "")) ?? 1000);
};

export const DEFAULT_EVENT_TIMEOUT = "24 hours";

export const isEventWake = (wake: Wake): wake is { readonly on: "event"; readonly timeout?: string } => "on" in wake;

export const nextTask = (task: string, attempt: number, wakes: ReadonlyArray<WakePayload | null>, lastGateReason: string | null): string => {
  if (attempt === 1) return task;

  const history = wakes.map((wake, index) => (wake === null ? `wake ${index + 1}: timer` : `wake ${index + 1} from ${wake.source}: ${wake.note ?? "(no note)"}`));
  const lines = [task, "", `This is attempt ${attempt}. The previous attempt did not pass${lastGateReason === null ? "" : `: ${lastGateReason}`}.`, ...history];

  return lines.join("\n");
};

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const hookSignature = (secret: string, loopId: string): Promise<string> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((key) => crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`wake:${loopId}`)))
    .then(hex);

export const sameText = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;

  return Array.from(left).reduce((diff, char, index) => diff | (char.charCodeAt(0) ^ right.charCodeAt(index)), 0) === 0;
};
