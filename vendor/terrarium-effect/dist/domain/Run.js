import * as Schema from "effect/Schema";
import { RunId } from "./RunId.js";
export const RunStatus = Schema.Literals([
    "queued",
    "running",
    "done",
    "failed",
    "cancelled"
]);
export const Run = Schema.Struct({
    runId: RunId,
    status: RunStatus,
    task: Schema.String,
    createdAt: Schema.String,
    terminalAt: Schema.NullOr(Schema.String),
    ok: Schema.NullOr(Schema.Boolean)
});
