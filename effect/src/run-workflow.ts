import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Result } from "effect";

import { failedOutcome, terminalOf } from "./run-workflow-terminal.ts";
import { ownerStoreOf } from "./runs.ts";
import type { RunParams, RunsEnv } from "./runs.ts";
import { Sandbox, sandboxLayer } from "./sandbox.ts";
import type { SandboxEnv } from "./sandbox.ts";

export const executeRun = (params: RunParams) => Effect.gen(function* () {
  const sandbox = yield* Sandbox;
  const result = yield* Effect.result(sandbox.run({ task: params.task, contract: params.contract, proof: params.proof ?? null }));
  const finishedAt = new Date().toISOString();

  return Result.match(result, { onSuccess: (success) => terminalOf(success, params.contract, finishedAt), onFailure: (failure) => failedOutcome(failure, finishedAt) });
});

export class RunWorkflow extends WorkflowEntrypoint<RunsEnv & SandboxEnv, RunParams> {
  async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
    const params = event.payload;
    const outcome = await step.do("run sandbox", () => Effect.runPromise(executeRun(params).pipe(Effect.provide(sandboxLayer(this.env)))));

    return step.do("record terminal", () => Effect.runPromise(ownerStoreOf(this.env, params.ownerId).finish(params.runId, outcome.terminal, outcome.logs).pipe(Effect.orDie)));
  }
}
