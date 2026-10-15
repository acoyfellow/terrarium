import { Clock, Duration, Effect } from "effect";

export interface StallPolicy {
  readonly windowMs: number;
  readonly checkEveryMs: number;
}

export const DEFAULT_STALL: StallPolicy = { windowMs: 180_000, checkEveryMs: 15_000 };

export interface Stalled {
  readonly quietMs: number;
}

export const isStalled = (nowMs: number, startMs: number, lastActivityMs: number | null, windowMs: number): boolean =>
  nowMs - Math.max(startMs, lastActivityMs ?? 0) >= windowMs;

export const stallMessage = (stalled: Stalled) =>
  `terrarium: stopped after ${Math.round(stalled.quietMs / 1000)}s with no model activity (no-progress wake)`;

export const watchStall = (lastActivity: Effect.Effect<number | null>, startMs: number, policy: StallPolicy = DEFAULT_STALL): Effect.Effect<Stalled> => {
  const check: Effect.Effect<Stalled> = Effect.sleep(Duration.millis(policy.checkEveryMs)).pipe(
    Effect.andThen(Effect.all({ nowMs: Clock.currentTimeMillis, last: lastActivity })),
    Effect.flatMap(({ nowMs, last }) => (isStalled(nowMs, startMs, last, policy.windowMs) ? Effect.succeed({ quietMs: nowMs - Math.max(startMs, last ?? 0) }) : check)),
  );

  return check;
};
