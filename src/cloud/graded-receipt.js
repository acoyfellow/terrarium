// Graded receipt integration (proof-carrying wiring). Single entry point that
// composes a Terrarium terminal (provenance authority) with an OPTIONAL advisory
// correctness annotation into one graded, calibrated, content-addressed receipt.
//
// Architectural note: a single run-cell has ONE attempt, so correctness (which
// needs independent attempts) is composed ABOVE the cell, over multiple runs or
// producers. This module is that composition layer. It NEVER mutates the
// terminal's authority fields; the grade + calibration + artifact all ride
// alongside as advisory metadata.

import { composeTrustGrade } from "./trust-grade.js";
import { attachCalibration } from "./trust-calibration.js";
import { applyCorrectnessAnnotation } from "./correctness-annotation.js";
import { mintReceiptArtifact } from "./receipt-artifact.js";

/**
 * Produce a graded view of a run terminal.
 * @param {object} input
 * @param {object} input.contract   { runId, taskFingerprint, nonce }
 * @param {object} input.terminal   the authoritative terminal (unchanged)
 * @param {object|null} [input.correctness]  advisory annotation (optional)
 * @returns {Promise<{ terminal:object, grade:object, artifact:object }>}
 *   terminal: original + advisory `correctness` slot (authority untouched)
 *   grade:    weakest-wins grade + measured calibration (calibrated:false if none)
 *   artifact: content-addressed, third-party re-verifiable receipt artifact
 */
export async function buildGradedReceipt({ contract, terminal, correctness = null } = {}) {
  if (!terminal || typeof terminal !== "object") throw new Error("terminal required");

  // 1. Advisory correctness rides alongside (never changes authority).
  const annotatedTerminal = correctness
    ? applyCorrectnessAnnotation(terminal, correctness)
    : terminal;

  // 2. Weakest-wins grade from provenance + correctness.
  const baseGrade = composeTrustGrade({
    provenance: terminal.taskContractStatus,
    correctness,
  });

  // 3. Attach the mechanism's MEASURED false-trust (fail closed: uncalibrated).
  const grade = attachCalibration(baseGrade, correctness);

  // 4. Mint the portable, content-addressed, re-verifiable artifact.
  const artifact = await mintReceiptArtifact({ contract, terminal: annotatedTerminal, correctness });

  return { terminal: annotatedTerminal, grade, artifact };
}
