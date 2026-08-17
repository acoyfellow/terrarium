import { Context, Effect, Layer } from "effect";
import { ClaimConflict, InvalidBudget, StoreReadFailed, StoreWriteFailed } from "../domain/errors.js";
export interface ChildRun {
    readonly runId: string;
    readonly parentRunId?: string | null;
}
export interface PruneOptions {
    readonly requesterRunId?: string;
}
export interface PrunedClaim {
    readonly claimPath: string;
    readonly childRunId: string | null;
}
export interface PruneResult {
    readonly pruned: ReadonlyArray<PrunedClaim>;
    readonly count: number;
}
export interface RunStore {
    readonly claim: (run: ChildRun) => Effect.Effect<string | null, ClaimConflict | InvalidBudget | StoreWriteFailed>;
    readonly release: (claimPath: string | null) => Effect.Effect<void, StoreWriteFailed>;
    readonly prune: (options?: PruneOptions) => Effect.Effect<PruneResult, StoreReadFailed | StoreWriteFailed>;
}
export declare const RunStore: Context.Service<RunStore, RunStore>;
export declare const RunStoreLive: (root: string) => Layer.Layer<RunStore, never, never>;
