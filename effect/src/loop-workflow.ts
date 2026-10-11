import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { Owner, Runs } from "./shared.ts";
import type { OwnerId, RunRecord } from "./shared.ts";
import { decideNext, gateAttempt } from "./loop-decide.ts";
import { runsLayer } from "./app.ts";
import type { Decision, Gate, LoopContract, RecordedAttempt } from "./loop-decide.ts";

export interface LoopParams {
  readonly loopId: string;
  readonly ownerId: OwnerId;
  readonly contract: LoopContract;
}

export interface LoopOutput {
  readonly decision: Decision;
  readonly attempts: ReadonlyArray<RecordedAttempt & { readonly gate: Gate }>;
}

const pollLimit = 180;

const toAttempt = (run: RunRecord): RecordedAttempt | null =>
  run.terminal === null
    ? null
    : { runId: run.runId, status: run.terminal.status, verified: run.terminal.contractStatus === "verified", logs: run.logs };

const admitAttempt = (contract: LoopContract, loopId: string, n: number) =>
  Effect.gen(function* () {
    const runs = yield* Runs;
    const run = yield* runs.admit({ task: contract.task, channel: `loop:${loopId}`, idempotencyKey: `loop-${loopId}-attempt-${n}` });

    return run.runId;
  });

const pollAttempt = (runId: RunRecord["runId"]) =>
  Effect.gen(function* () {
    const runs = yield* Runs;

    return toAttempt(yield* runs.get(runId));
  });

export const makeLoopWorkflow = <E>(runsLayer: (env: E) => Layer.Layer<Runs>) =>
  class LoopWorkflow extends WorkflowEntrypoint<E, LoopParams> {
    async run(event: Readonly<WorkflowEvent<LoopParams>>, step: WorkflowStep): Promise<LoopOutput> {
      const { loopId, ownerId, contract } = event.payload;
      const layer = Layer.merge(runsLayer(this.env), Layer.succeed(Owner, { id: ownerId, method: "bearer", email: null }));
      const exec = <A>(program: Effect.Effect<A, unknown, Runs | Owner>) => Effect.runPromise(Effect.provide(program, layer));
      const attempts: Array<RecordedAttempt & { readonly gate: Gate }> = [];

      for (;;) {
        const decision = decideNext(contract, attempts);

        if (decision.action === "stop") return { decision, attempts };

        const n = decision.attempt;

        const runId = await step.do(`attempt-${n}-admit`, () =>
          exec(admitAttempt(contract, loopId, n)));

        const attempt = await this.waitFor(step, n, runId, exec);
        attempts.push({ ...attempt, gate: gateAttempt(contract, attempt) });
      }
    }

    private async waitFor(step: WorkflowStep, n: number, runId: RunRecord["runId"], exec: <A>(program: Effect.Effect<A, unknown, Runs | Owner>) => Promise<A>): Promise<RecordedAttempt> {
      for (let poll = 0; poll < pollLimit; poll++) {
        const attempt = await step.do<RecordedAttempt | null>(`attempt-${n}-poll-${poll}`, () =>
          exec(pollAttempt(runId)));

        if (attempt !== null) return attempt;

        await step.sleep(`attempt-${n}-wait-${poll}`, "10 seconds");
      }

      return { runId, status: "timeout", verified: false, logs: "" };
    }
  };

export const LoopWorkflow = makeLoopWorkflow(runsLayer);
