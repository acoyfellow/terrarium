import { Duration, Effect, Option } from "effect";

import type { CallbackEvent, CloudError } from "./cloud.ts";

export interface WatchPolicy {
  readonly pollMs: number;
  readonly maxPolls: number;
  readonly maxConsecutiveFailures: number;
}

export const DEFAULT_WATCH_POLICY: WatchPolicy = { pollMs: 15_000, maxPolls: 160, maxConsecutiveFailures: 8 };

export type WatchOutcome =
  | { readonly kind: "finished"; readonly event: CallbackEvent }
  | { readonly kind: "gave-up"; readonly reason: string };

type Probe = Effect.Effect<Option.Option<CallbackEvent>, CloudError>;

const stepAfter = (policy: WatchPolicy, probe: Probe, poll: number, failures: number): Effect.Effect<WatchOutcome> => {
  if (poll >= policy.maxPolls) return Effect.succeed({ kind: "gave-up", reason: `no result after ${policy.maxPolls} polls` });

  if (failures >= policy.maxConsecutiveFailures) return Effect.succeed({ kind: "gave-up", reason: `${failures} failed polls in a row` });

  return Effect.sleep(Duration.millis(policy.pollMs)).pipe(
    Effect.andThen(probe),
    Effect.matchEffect({
      onFailure: () => stepAfter(policy, probe, poll + 1, failures + 1),
      onSuccess: Option.match({
        onNone: () => stepAfter(policy, probe, poll + 1, 0),
        onSome: (event): Effect.Effect<WatchOutcome> => Effect.succeed({ kind: "finished", event }),
      }),
    }),
  );
};

export const watchRun = (probe: Probe, policy: WatchPolicy = DEFAULT_WATCH_POLICY): Effect.Effect<WatchOutcome> => stepAfter(policy, probe, 0, 0);
