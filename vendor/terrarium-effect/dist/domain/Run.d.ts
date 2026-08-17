import * as Schema from "effect/Schema";
export declare const RunStatus: Schema.Literals<readonly ["queued", "running", "done", "failed", "cancelled"]>;
export type RunStatus = Schema.Schema.Type<typeof RunStatus>;
export declare const Run: Schema.Struct<{
    readonly runId: Schema.brand<Schema.String, "RunId">;
    readonly status: Schema.Literals<readonly ["queued", "running", "done", "failed", "cancelled"]>;
    readonly task: Schema.String;
    readonly createdAt: Schema.String;
    readonly terminalAt: Schema.NullOr<Schema.String>;
    readonly ok: Schema.NullOr<Schema.Boolean>;
}>;
export type Run = Schema.Schema.Type<typeof Run>;
