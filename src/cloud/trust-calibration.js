// Trust calibration registry (proof-carrying E5). A grade is only as credible
// as the MEASURED error rate of the mechanism that produced it. This registry
// holds calibration records derived from real accuracy-bench runs, so a grade
// can carry its own false-trust posture instead of an asserted one.
//
// Invariants:
//   * A calibration entry MUST cite real measurement evidence (runs, dataset,
//     observed wrong-trusted count). No synthesized rates.
//   * Fail closed: an uncalibrated mechanism/gate returns calibration=null and
//     the grade must be treated as UNCALIBRATED (not "0% false-trust").
//   * These are LOCAL-ONLY measurements on a bounded bench; the bound is an
//     upper estimate from small N, never a proof of zero.

// Records are keyed by `${mechanism}:${gate}`. Each entry is evidence-backed:
// evals = total task evaluations observed; wrongTrusted = confidently-wrong
// decisions; falseTrust = wrongTrusted/evals; coverage = decisive/evals.
// Update ONLY from reconciled same-run ledger evidence.
export const CALIBRATION = Object.freeze({
  "single-run:none": Object.freeze({
    mechanism: "single-run", gate: "none", evals: 12, wrongTrusted: 2,
    falseTrust: 0.167, coverage: 1.0, dataset: "accuracy-bench/tasks-hard@12",
    label: "LOCAL-ONLY", note: "frontier single-run baseline",
  }),
  "cross-model-agreement:unanimous": Object.freeze({
    mechanism: "cross-model-agreement", gate: "unanimous", evals: 74, wrongTrusted: 0,
    falseTrust: 0.0, coverage: 0.72, dataset: "accuracy-bench/tasks-hard@12-30 (multi-run)",
    label: "LOCAL-ONLY", note: "0 confidently-wrong observed in 74 hard evals (incl 30-task run 24/0/6); small-N upper bound, not proven zero",
  }),
  "cross-model-agreement:majority": Object.freeze({
    mechanism: "cross-model-agreement", gate: "majority", evals: 50, wrongTrusted: 0,
    falseTrust: 0.0, coverage: 0.88, dataset: "accuracy-bench/tasks-hard@20-30 (multi-run)",
    label: "LOCAL-ONLY", note: "best cost<->trust point; 0 wrong-trusted in 50 hard evals (30-task run 27/0/3, coverage 90%); small-N",
  }),
});

/**
 * Look up the measured calibration for a mechanism+gate. Returns null (fail
 * closed) when the pair is not calibrated — callers MUST treat null as
 * "uncalibrated", never as zero false-trust.
 */
export function lookupCalibration(mechanism, gate) {
  if (!mechanism || !gate) return null;
  return CALIBRATION[`${mechanism}:${gate}`] ?? null;
}

/**
 * Attach the measured false-trust posture to a composed grade. The calibration
 * is ADVISORY metadata about the MECHANISM, never a per-answer guarantee. An
 * uncalibrated mechanism yields calibration:null and calibrated:false.
 * @param {object} grade   output of composeTrustGrade
 * @param {object|null} annotation  the correctness annotation (has mechanism+gate)
 */
export function attachCalibration(grade, annotation = null) {
  const mechanism = annotation?.mechanism ?? null;
  const gate = annotation?.gate ?? null;
  const cal = lookupCalibration(mechanism, gate);
  return {
    ...grade,
    calibration: cal
      ? { mechanism, gate, measuredFalseTrust: cal.falseTrust, coverage: cal.coverage, evals: cal.evals, dataset: cal.dataset, label: cal.label }
      : null,
    calibrated: Boolean(cal),
  };
}

export const _internals = { CALIBRATION };
