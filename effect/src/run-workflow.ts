import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Context, Effect, Layer, Result } from "effect";

import { verifyReceipt } from "./receipt.ts";
import { ownerStoreOf } from "./runs.ts";
import type { RunParams, RunsEnv } from "./runs.ts";
import { Upstream } from "./shared.ts";
import type { RunContract, RunTerminal } from "./shared.ts";

export interface SandboxResult {
  readonly output: string;
  readonly exitCode: number;
}

export class Sandbox extends Context.Service<Sandbox, { readonly run: (task: string, contract: RunContract) => Effect.Effect<SandboxResult, Upstream> }>()("terrarium/Sandbox") {}

export const SandboxNotWired = Layer.succeed(Sandbox, Sandbox.of({ run: () => Effect.fail(new Upstream({ service: "sandbox", detail: "not wired" })) }));

export interface Outcome {
  readonly terminal: RunTerminal;
  readonly logs: string;
}

export const terminalOf = (result: SandboxResult, contract: RunContract, finishedAt: string): Outcome => {
  const verdict = verifyReceipt(result.output, contract);
  const done = result.exitCode === 0 && verdict.contractStatus === "verified";

  return { terminal: { status: done ? "done" : "failed", contractStatus: verdict.contractStatus, summary: verdict.summary, exitCode: result.exitCode, finishedAt }, logs: result.output };
};

const failedOutcome = (error: Upstream, finishedAt: string): Outcome => ({
  terminal: { status: "failed", contractStatus: "missing", summary: null, exitCode: null, finishedAt },
  logs: `${error.service}: ${error.detail}`,
});

export const executeRun = (params: RunParams) => Effect.gen(function* () {
  const sandbox = yield* Sandbox;
  const result = yield* Effect.result(sandbox.run(params.task, params.contract));
  const finishedAt = new Date().toISOString();

  return Result.match(result, { onSuccess: (success) => terminalOf(success, params.contract, finishedAt), onFailure: (failure) => failedOutcome(failure, finishedAt) });
});

export class RunWorkflow extends WorkflowEntrypoint<RunsEnv, RunParams> {
  async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
    const params = event.payload;
    const outcome = await step.do("run sandbox", () => Effect.runPromise(executeRun(params).pipe(Effect.provide(SandboxNotWired))));

    return step.do("record terminal", () => Effect.runPromise(ownerStoreOf(this.env, params.ownerId).finish(params.runId, outcome.terminal, outcome.logs).pipe(Effect.orDie)));
  }
}
