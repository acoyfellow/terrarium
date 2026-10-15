import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect } from "effect";

import { onceOnly } from "./run-once.ts";
import { ownerStoreOf } from "./runs.ts";
import type { RunParams, RunsEnv } from "./runs.ts";
import { sandboxLayer } from "./sandbox.ts";
import type { SandboxEnv } from "./sandbox.ts";

export class RunWorkflow extends WorkflowEntrypoint<RunsEnv & SandboxEnv, RunParams> {
  async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
    const params = event.payload;
    const store = ownerStoreOf(this.env, params.ownerId);
    const outcome = await step.do("run sandbox", () => Effect.runPromise(onceOnly(store, params).pipe(Effect.provide(sandboxLayer(this.env)))));

    return step.do("record terminal", () => Effect.runPromise(store.finish(params.runId, outcome.terminal, outcome.logs).pipe(Effect.orDie)));
  }
}
