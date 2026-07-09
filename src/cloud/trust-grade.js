// Weakest-wins trust grade lattice (proof-carrying-experiments E1).
//
// Composes Terrarium's two independent warrants into ONE non-launderable grade:
//   * provenance: did the task run and correlate? (runId+taskFingerprint+nonce)
//   * correctness: is the answer trustworthy? (advisory, from a real mechanism)
//
// Rule: WEAKEST WINS. The overall grade can never exceed the weaker input, and
// an advisory correctness signal can never lift a failed provenance. Unknown is
// treated as the floor for correctness — fail closed, never optimistic.
//
// This is a Stage-1 proof-carrying value: a graded warrant that travels with the
// result and cannot be laundered upward.

// Ordered lattice, lowest -> highest. Index is the strength.
const PROVENANCE_ORDER = ["missing", "malformed", "mismatch", "not-applicable", "not-required", "verified"];
// The only provenance states that carry positive task-success warrant.
const PROVENANCE_TRUSTWORTHY = new Set(["verified"]);

// Correctness lattice. "unknown" is the fail-closed floor; "trusted" is earned.
const CORRECTNESS_ORDER = ["untrusted", "unknown", "trusted"];

// Overall grade lattice.
const GRADE = { NONE: "none", PROVENANCE_ONLY: "provenance-only", TRUSTED: "trusted" };

/**
 * Compose a single overall trust grade from provenance + optional correctness.
 * @param {object} input
 * @param {string} input.provenance   taskContractStatus (verified|missing|...)
 * @param {object|null} [input.correctness]  advisory annotation { verdict, advisory }
 * @returns {{ grade: string, provenance: string, correctness: string,
 *            trustworthy: boolean, reason: string }}
 */
export function composeTrustGrade({ provenance, correctness = null } = {}) {
  const prov = PROVENANCE_ORDER.includes(provenance) ? provenance : "missing";
  const provOk = PROVENANCE_TRUSTWORTHY.has(prov);

  // Correctness is advisory ONLY. A non-advisory or absent object is floored to
  // "unknown"; a malformed verdict is floored to "unknown"; never synthesized up.
  let corr = "unknown";
  if (correctness && correctness.advisory === true && typeof correctness.verdict === "string") {
    if (correctness.verdict === "trusted") corr = "trusted";
    else if (correctness.verdict === "unknown") corr = "unknown";
    else corr = "untrusted";
  }

  // WEAKEST WINS:
  // 1. If provenance is not trustworthy, the overall grade is at most NONE for
  //    task success — correctness advisory CANNOT lift it. (non-launderable)
  if (!provOk) {
    return { grade: GRADE.NONE, provenance: prov, correctness: corr, trustworthy: false,
      reason: `provenance ${prov} is not a success warrant; advisory correctness cannot upgrade it` };
  }
  // 2. Provenance is verified. Overall is PROVENANCE_ONLY unless correctness is
  //    earned "trusted", which raises it to TRUSTED. unknown/untrusted stays at
  //    provenance-only (fail closed: we have provenance but not earned correctness).
  if (corr === "trusted") {
    return { grade: GRADE.TRUSTED, provenance: prov, correctness: corr, trustworthy: true,
      reason: "verified provenance AND earned correctness" };
  }
  return { grade: GRADE.PROVENANCE_ONLY, provenance: prov, correctness: corr, trustworthy: true,
    reason: `verified provenance; correctness ${corr} (not earned) — provenance-only` };
}

export const _lattice = { PROVENANCE_ORDER, CORRECTNESS_ORDER, GRADE, PROVENANCE_TRUSTWORTHY };
