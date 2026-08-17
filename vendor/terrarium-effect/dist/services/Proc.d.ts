import { Context, Effect, Layer } from "effect";
import { SpawnFailed, Timeout } from "../domain/errors.js";
export interface ProcOptions {
    readonly cwd?: string;
    readonly timeoutMs?: number;
}
export interface ProcResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
export interface Proc {
    readonly capture: (command: string, args: readonly string[], options: ProcOptions) => Effect.Effect<ProcResult, SpawnFailed | Timeout>;
}
export declare const Proc: Context.Service<Proc, Proc>;
export interface ProcScript {
    readonly command: string;
    readonly args: readonly string[];
    readonly result: ProcResult | SpawnFailed | Timeout;
}
export declare const ProcLive: Layer.Layer<Proc, never, never>;
export declare const ProcTest: (scripts: ReadonlyArray<ProcScript>) => Layer.Layer<Proc, never, never>;
