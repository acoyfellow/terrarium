import { Context, Effect, Result } from "effect";

import { failedOutcome, refusedRestart, terminalOf } from "./run-workflow-terminal.ts";
import type { RunParams } from "./runs.ts";
import type { OwnerStore } from "./runs.ts";
import type { SandboxJob, SandboxResult } from "./sandbox-result.ts";
import type { Upstream } from "./shared.ts";

export class Sandbox extends Context.Service<Sandbox, { readonly run: (job: SandboxJob) => Effect.Effect<SandboxResult, Upstream> }>()("terrarium/Sandbox") {}

export const executeRun = (params: RunParams) => Effect.gen(function* () {
  const sandbox = yield* Sandbox;
  const result = yield* Effect.result(sandbox.run({ task: params.task, contract: params.contract, proof: params.proof ?? null, resume: params.resume ?? null, repo: params.repo ?? null, ownerId: params.ownerId }));
  const finishedAt = new Date().toISOString();

  return Result.match(result, { onSuccess: (success) => terminalOf(success, params.contract, finishedAt), onFailure: (failure) => failedOutcome(failure, finishedAt) });
});

export const onceOnly = (store: Pick<OwnerStore, "beginStart">, params: RunParams) =>
  store.beginStart(params.runId, Date.now()).pipe(
    Effect.orDie,
    Effect.flatMap((lease) => (lease.first ? executeRun(params) : Effect.succeed(refusedRestart(lease.attempts, new Date().toISOString())))),
  );
