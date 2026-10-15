import { Option, Schema } from "effect";

export const METRIC_MARKER = "TERRARIUM_METRIC";

export const Metric = Schema.Struct({
  command: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(1000)),
  direction: Schema.Literals(["lower", "higher"]),
  seed: Schema.optionalKey(Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(4000))),
  baselineRuns: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 }))),
  minGain: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  target: Schema.optionalKey(Schema.Number),
});

export type Metric = typeof Metric.Type;

export const DEFAULT_BASELINE_RUNS = 3;

export const IDLE_TASK = "Do not change any files. Reply DONE.";

export const metricProof = (metric: Metric): string => `value=$( ${metric.command} ); echo "${METRIC_MARKER} $value"`;

const markerLine = new RegExp(`^${METRIC_MARKER} (-?[0-9]+(?:\\.[0-9]+)?)\\s*$`, "m");

export const parseMetric = (output: string | null): Option.Option<number> => {
  const match = markerLine.exec(output ?? "");

  return match === null ? Option.none() : Option.some(Number(match[1]));
};

export interface Baseline {
  readonly values: ReadonlyArray<number>;
  readonly median: number;
  readonly noise: number;
}

export const baselineOf = (values: ReadonlyArray<number>): Baseline => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;

  return { values, median, noise: sorted.length === 0 ? 0 : sorted[sorted.length - 1] - sorted[0] };
};

export const threshold = (metric: Metric, baseline: Baseline) => Math.max(baseline.noise, metric.minGain ?? 0);

export const isBetter = (metric: Metric, baseline: Baseline, best: number, value: number): boolean =>
  metric.direction === "lower" ? best - value > threshold(metric, baseline) : value - best > threshold(metric, baseline);

export const reachedTarget = (metric: Metric, value: number): boolean => {
  if (metric.target === undefined) return false;

  return metric.direction === "lower" ? value <= metric.target : value >= metric.target;
};

export interface MetricStep {
  readonly runId: string | null;
  readonly value: number | null;
  readonly accepted: boolean;
  readonly reason: string;
}

export interface Ratchet {
  readonly best: number;
  readonly bestRunId: string;
  readonly steps: ReadonlyArray<MetricStep>;
}

export const ratchetStep = (metric: Metric, baseline: Baseline, state: Ratchet, runId: string | null, value: Option.Option<number>): Ratchet =>
  Option.match(value, {
    onNone: () => ({ ...state, steps: [...state.steps, { runId, value: null, accepted: false, reason: "metric did not print a number" }] }),
    onSome: (measured) => {
      if (runId === null || !isBetter(metric, baseline, state.best, measured)) return { ...state, steps: [...state.steps, { runId, value: measured, accepted: false, reason: `not better than ${state.best} by more than ${threshold(metric, baseline)}` }] };

      return { best: measured, bestRunId: runId, steps: [...state.steps, { runId, value: measured, accepted: true, reason: `improved ${state.best} -> ${measured}` }] };
    },
  });

export const ratchetTask = (task: string, state: Ratchet, metric: Metric): string =>
  [
    task,
    "",
    `The workspace is the best result so far. The metric is \`${metric.command}\`; ${metric.direction} is better. Current best: ${state.best}.`,
    ...state.steps.slice(-3).map((step) => `Earlier attempt: ${step.value ?? "no value"} (${step.accepted ? "kept" : "discarded"}: ${step.reason}).`),
  ].join("\n");
