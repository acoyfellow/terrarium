import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { Owner, Runs } from "./shared.ts";
import type { OwnerId, RunRecord, RunTerminal } from "./shared.ts";
import { checkResults } from "./loop-checks.ts";
import { decideNext, gateAttempt, runProofOf } from "./loop-decide.ts";
import { runsLayer } from "./app.ts";
import type { Decision, Gate, LoopContract, RecordedAttempt } from "./loop-decide.ts";
import { sumUsage } from "./usage.ts";
import { DEFAULT_EVENT_TIMEOUT, WAKE_EVENT, WakePayload, durationMs, isEventWake, nextTask } from "./wake.ts";
import type { Wake } from "./wake.ts";
import type { Usage } from "./usage.ts";

const usageOf = (terminal: RunTerminal): Pick<RecordedAttempt, "usage"> => (terminal.usage === undefined ? {} : { usage: terminal.usage });

export interface LoopParams {
  readonly loopId: string;
  readonly ownerId: OwnerId;
  readonly contract: LoopContract;
}

export interface LoopOutput {
  readonly decision: Decision;
  readonly attempts: ReadonlyArray<RecordedAttempt & { readonly gate: Gate }>;
  readonly usage: Usage;
  readonly wakes?: ReadonlyArray<WakePayload | null>;
}

const pollLimit = 180;

const toAttempt = (run: RunRecord): RecordedAttempt | null =>
  run.terminal === null
    ? null
    : { runId: run.runId, status: run.terminal.status, fromThisRun: run.terminal.provenance === "this-run", proofExit: run.terminal.proof?.exitCode ?? null, summary: run.terminal.summary, ...usageOf(run.terminal), proofOutput: run.terminal.proof?.output ?? null, logs: run.logs };

const admitAttempt = (contract: LoopContract, loopId: string, n: number, task: string) =>
  Effect.gen(function* () {
    const runs = yield* Runs;
    const run = yield* runs.admit({ task, proof: runProofOf(contract), channel: `loop:${loopId}`, idempotencyKey: `loop-${loopId}-attempt-${n}` });

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
      const wakes: Array<WakePayload | null> = [];

      for (;;) {
        const decision = decideNext(contract, attempts);

        if (decision.action === "stop") return { decision, attempts, wakes, usage: sumUsage(attempts.flatMap((attempt) => (attempt.usage === undefined ? [] : [attempt.usage]))) };

        const n = decision.attempt;

        if (n > 1 && contract.wake !== undefined) wakes.push(await this.sleepUntilWake(step, n, contract.wake));

        const task = contract.wake === undefined ? contract.task : nextTask(contract.task, n, wakes, attempts.at(-1)?.gate.reason ?? null);

        const runId = await step.do(`attempt-${n}-admit`, () =>
          exec(admitAttempt(contract, loopId, n, task)));

        const attempt = await this.waitFor(step, n, runId, exec);
        const scored = contract.checks === undefined ? attempt : { ...attempt, checks: checkResults(contract.checks, contract.proof, attempt.proofOutput ?? null) };

        attempts.push({ ...scored, gate: gateAttempt(contract, scored) });
      }
    }

    private async sleepUntilWake(step: WorkflowStep, n: number, wake: Wake): Promise<WakePayload | null> {
      if (!isEventWake(wake)) {
        await step.sleep(`wake-${n}-timer`, durationMs(wake.every));

        return null;
      }

      const received = await step.waitForEvent<WakePayload>(`wake-${n}-event`, { type: WAKE_EVENT, timeout: durationMs(wake.timeout ?? DEFAULT_EVENT_TIMEOUT) }).catch(() => null);

      return received === null ? null : Option.getOrNull(Schema.decodeUnknownOption(WakePayload)(received.payload));
    }

    private async waitFor(step: WorkflowStep, n: number, runId: RunRecord["runId"], exec: <A>(program: Effect.Effect<A, unknown, Runs | Owner>) => Promise<A>): Promise<RecordedAttempt> {
      for (let poll = 0; poll < pollLimit; poll++) {
        const attempt = await step.do<RecordedAttempt | null>(`attempt-${n}-poll-${poll}`, () =>
          exec(pollAttempt(runId)));

        if (attempt !== null) return attempt;

        await step.sleep(`attempt-${n}-wait-${poll}`, "10 seconds");
      }

      return { runId, status: "timeout", fromThisRun: false, logs: "" };
    }
  };

export const LoopWorkflow = makeLoopWorkflow(runsLayer);
