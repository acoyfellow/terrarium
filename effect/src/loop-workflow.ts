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
import { DEFAULT_BASELINE_RUNS, IDLE_TASK, baselineOf, metricProof, parseMetric, ratchetStep, ratchetTask, reachedTarget } from "./metric.ts";
import type { Baseline, Metric, Ratchet } from "./metric.ts";
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
  readonly metric?: MetricOutput;
}

export interface MetricOutput {
  readonly seedRunId: string;
  readonly baseline: Baseline;
  readonly baselineRunIds: ReadonlyArray<string>;
  readonly ratchet: Ratchet;
  readonly stoppedBecause: string;
}

const pollLimit = 180;

const toAttempt = (run: RunRecord): RecordedAttempt | null =>
  run.terminal === null
    ? null
    : { runId: run.runId, status: run.terminal.status, fromThisRun: run.terminal.provenance === "this-run", proofExit: run.terminal.proof?.exitCode ?? null, summary: run.terminal.summary, ...usageOf(run.terminal), proofOutput: run.terminal.proof?.output ?? null, logs: run.logs };

const admitAttempt = (contract: LoopContract, loopId: string, n: number, task: string) => admitRun(loopId, `attempt-${n}`, task, runProofOf(contract), null);

const admitRun = (loopId: string, label: string, task: string, proof: string | null, resumeFrom: string | null) =>
  Effect.gen(function* () {
    const runs = yield* Runs;
    const run = yield* runs.admit({ task, proof, channel: `loop:${loopId}`, idempotencyKey: `loop-${loopId}-${label}`, resumeFrom });

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

      if (contract.metric !== undefined) return this.metricLoop(step, loopId, contract, contract.metric, exec);

      for (;;) {
        const decision = decideNext(contract, attempts);

        if (decision.action === "stop") return { decision, attempts, wakes, usage: sumUsage(attempts.flatMap((attempt) => (attempt.usage === undefined ? [] : [attempt.usage]))) };

        const n = decision.attempt;

        if (n > 1 && contract.wake !== undefined) wakes.push(await this.sleepUntilWake(step, n, contract.wake));

        const task = contract.wake === undefined ? contract.task : nextTask(contract.task, n, wakes, attempts.at(-1)?.gate.reason ?? null);

        const runId = await step.do(`attempt-${n}-admit`, () =>
          exec(admitAttempt(contract, loopId, n, task)));

        const attempt = await this.waitFor(step, `attempt-${n}`, runId, exec);
        const scored = contract.checks === undefined ? attempt : { ...attempt, checks: checkResults(contract.checks, contract.proof, attempt.proofOutput ?? null) };

        attempts.push({ ...scored, gate: gateAttempt(contract, scored) });
      }
    }

    private async measured(step: WorkflowStep, loopId: string, label: string, task: string, metric: Metric, resumeFrom: string | null, exec: <A>(program: Effect.Effect<A, unknown, Runs | Owner>) => Promise<A>): Promise<RecordedAttempt> {
      const runId = await step.do(`${label}-admit`, () => exec(admitRun(loopId, label, task, metricProof(metric), resumeFrom)));

      return this.waitFor(step, label, runId, exec);
    }

    private async metricLoop(step: WorkflowStep, loopId: string, contract: LoopContract, metric: Metric, exec: <A>(program: Effect.Effect<A, unknown, Runs | Owner>) => Promise<A>): Promise<LoopOutput> {
      const seed = await this.measured(step, loopId, "seed", metric.seed ?? IDLE_TASK, metric, null, exec);
      const seedRunId = seed.runId ?? "";
      const baselineRuns: Array<RecordedAttempt> = [];

      for (let index = 0; index < (metric.baselineRuns ?? DEFAULT_BASELINE_RUNS); index++) baselineRuns.push(await this.measured(step, loopId, `baseline-${index}`, IDLE_TASK, metric, seedRunId, exec));

      const values = [seed, ...baselineRuns].flatMap((run) => Option.toArray(parseMetric(run.proofOutput ?? null)));
      const baseline = baselineOf(values);
      const attempts: Array<RecordedAttempt & { readonly gate: Gate }> = [];
      const all = [seed, ...baselineRuns];

      const finish = (ratchet: Ratchet, stoppedBecause: string, outcome: "passed" | "exhausted"): LoopOutput => ({
        decision: { action: "stop", outcome, reason: stoppedBecause },
        attempts,
        usage: sumUsage([...all, ...attempts].flatMap((attempt) => (attempt.usage === undefined ? [] : [attempt.usage]))),
        metric: { seedRunId, baseline, baselineRunIds: baselineRuns.map((run) => run.runId ?? ""), ratchet, stoppedBecause },
      });

      if (values.length < 2) return finish({ best: Number.NaN, bestRunId: seedRunId, steps: [] }, "baseline did not produce at least 2 numbers", "exhausted");

      let ratchet: Ratchet = { best: baseline.median, bestRunId: seedRunId, steps: [] };

      for (let n = 1; n <= contract.maxAttempts; n++) {
        const attempt = await this.measured(step, loopId, `attempt-${n}`, ratchetTask(contract.task, ratchet, metric), metric, ratchet.bestRunId, exec);
        const next = ratchetStep(metric, baseline, ratchet, attempt.runId, parseMetric(attempt.proofOutput ?? null));
        const kept = next.bestRunId !== ratchet.bestRunId;

        attempts.push({ ...attempt, gate: { passed: kept, reason: next.steps.at(-1)?.reason ?? "" } });
        ratchet = next;

        if (kept && reachedTarget(metric, ratchet.best)) return finish(ratchet, `reached target ${metric.target}`, "passed");
      }

      return finish(ratchet, `${contract.maxAttempts} attempts used; best ${ratchet.best} (baseline ${baseline.median} ± ${baseline.noise})`, ratchet.steps.some((one) => one.accepted) ? "passed" : "exhausted");
    }

    private async sleepUntilWake(step: WorkflowStep, n: number, wake: Wake): Promise<WakePayload | null> {
      if (!isEventWake(wake)) {
        await step.sleep(`wake-${n}-timer`, durationMs(wake.every));

        return null;
      }

      const received = await step.waitForEvent<WakePayload>(`wake-${n}-event`, { type: WAKE_EVENT, timeout: durationMs(wake.timeout ?? DEFAULT_EVENT_TIMEOUT) }).catch(() => null);

      return received === null ? null : Option.getOrNull(Schema.decodeUnknownOption(WakePayload)(received.payload));
    }

    private async waitFor(step: WorkflowStep, label: string, runId: RunRecord["runId"], exec: <A>(program: Effect.Effect<A, unknown, Runs | Owner>) => Promise<A>): Promise<RecordedAttempt> {
      for (let poll = 0; poll < pollLimit; poll++) {
        const attempt = await step.do<RecordedAttempt | null>(`${label}-poll-${poll}`, () =>
          exec(pollAttempt(runId)));

        if (attempt !== null) return attempt;

        await step.sleep(`${label}-wait-${poll}`, "10 seconds");
      }

      return { runId, status: "timeout", fromThisRun: false, logs: "" };
    }
  };

export const LoopWorkflow = makeLoopWorkflow(runsLayer);
