// Advisory correctness annotation (accuracy-trust-scale loop, C5).
//
// A provenance receipt (runId + taskFingerprint + nonce) proves the task RAN and
// the output is CORRELATED — it does NOT prove the answer is CORRECT. This module
// produces an ADVISORY correctness annotation from a real, reproducible agreement
// mechanism (e.g. cross-model majority/unanimous) with a measured false-trust
// posture. It is designed to ride ALONGSIDE the terminal receipt exactly like the
// capability envelope: it can annotate, but it can NEVER upgrade or downgrade
// taskContractStatus / ok / status / the correlation triple.
//
// Invariants:
//   * Never synthesized: an annotation requires real per-model answers.
//   * Fail closed: no decisive agreement => verdict "unknown", never "trusted".
//   * Advisory only: applyAnnotation copies the annotation into terminal.correctness
//     and touches nothing else. A frozen guard proves it cannot mutate authority.

const VALID_GATES = new Set(["unanimous", "majority"]);

function normalizeAnswer(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Compute an advisory correctness verdict from independent model answers.
 * @param {object} input
 * @param {string[]} input.answers   raw answer texts, one per independent model
 * @param {string[]} input.models    model identifiers (parallel to answers)
 * @param {"unanimous"|"majority"} input.gate
 * @returns {{ schema:string, mechanism:string, gate:string, models:string[],
 *            samples:number, agreement:number, verdict:"trusted"|"unknown",
 *            advisory:true }}
 */
export function computeCorrectnessAnnotation({ answers, models = [], gate = "unanimous" } = {}) {
  if (!Array.isArray(answers) || answers.length < 2) {
    // Cannot establish agreement from fewer than 2 independent answers.
    return annotation({ gate, models, samples: Array.isArray(answers) ? answers.length : 0, agreement: 0, verdict: "unknown" });
  }
  if (!VALID_GATES.has(gate)) gate = "unanimous";
  const keys = answers.map(normalizeAnswer);
  // An empty/failed answer can never contribute to trust.
  if (keys.some((k) => k === "")) {
    return annotation({ gate, models, samples: answers.length, agreement: 0, verdict: "unknown" });
  }
  const counts = new Map();
  for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
  let bestN = 0, tie = false;
  for (const n of counts.values()) { if (n > bestN) { bestN = n; tie = false; } else if (n === bestN) tie = true; }
  const total = answers.length;
  let decisive;
  if (gate === "unanimous") decisive = bestN === total;
  else decisive = bestN > total / 2 && !tie; // strict majority, no tie
  return annotation({ gate, models, samples: total, agreement: bestN, verdict: decisive ? "trusted" : "unknown" });
}

function annotation({ gate, models, samples, agreement, verdict }) {
  return Object.freeze({
    schema: "terrarium-correctness-annotation-v0",
    mechanism: "cross-model-agreement",
    gate,
    models: Object.freeze([...models]),
    samples,
    agreement,
    verdict, // "trusted" | "unknown" — never "correct"/"verified" (not authority)
    advisory: true,
  });
}

/**
 * Attach an advisory annotation to a terminal WITHOUT touching authority fields.
 * Returns a NEW terminal object; the correctness annotation lives only under
 * `terminal.correctness`. taskContractStatus, ok, status, reason, and the
 * correlation triple are copied verbatim and can never be changed here.
 */
export function applyCorrectnessAnnotation(terminal, annotationObj) {
  if (!terminal || typeof terminal !== "object") throw new Error("terminal required");
  if (!annotationObj || annotationObj.advisory !== true) throw new Error("annotation must be advisory");
  // Structural guarantee: build the result from the original authority fields,
  // then add ONLY the advisory slot. No path here writes taskContractStatus etc.
  return {
    ...terminal,
    correctness: annotationObj,
  };
}

export const _testables = { normalizeAnswer, VALID_GATES };
