// Content-addressed, re-verifiable receipt artifact (proof-carrying E2, Stage-2).
//
// Stage 1 (today): the receipt proves provenance INSIDE the running system (the
// DO holds the contract; you trust the system that ran it).
// Stage 2 (this module): the receipt becomes a PORTABLE artifact whose id IS its
// content hash, carrying the correlation triple + terminal + advisory grade, so
// a THIRD PARTY can re-verify integrity and internal consistency with ONLY the
// artifact and this small verifier — no run access, no DO, no network.
//
// This does NOT (and must not) re-establish task success by itself: it proves
// the artifact is intact and internally consistent (its content hash matches,
// its correlation triple is well-formed, its grade was composed by the
// weakest-wins rule). Trusting the ANSWER still requires the grade + the
// mechanism's measured error rate. Integrity != correctness — kept distinct.

import { composeTrustGrade } from "./trust-grade.js";

const ARTIFACT_SCHEMA = "terrarium-receipt-artifact-v0";

async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Deterministic canonical JSON (sorted keys) so the content hash is stable
// across producers and re-serialization. No floats/Dates in the payload.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

/**
 * Mint a content-addressed receipt artifact. The artifactId is the SHA-256 of
 * the canonical body, so the id cannot be forged without changing the content.
 * @param {object} input
 * @param {{runId,taskFingerprint,nonce}} input.contract
 * @param {object} input.terminal  { status, ok, taskContractStatus, ... }
 * @param {object|null} [input.correctness] advisory annotation
 */
export async function mintReceiptArtifact({ contract, terminal, correctness = null } = {}) {
  if (!contract?.runId || !contract?.taskFingerprint || !contract?.nonce) {
    throw new Error("receipt artifact requires a full correlation triple");
  }
  const grade = composeTrustGrade({ provenance: terminal?.taskContractStatus, correctness });
  const body = {
    schema: ARTIFACT_SCHEMA,
    contract: { runId: contract.runId, taskFingerprint: contract.taskFingerprint, nonce: contract.nonce },
    terminal: {
      status: terminal?.status ?? null,
      ok: terminal?.ok === true,
      taskContractStatus: terminal?.taskContractStatus ?? null,
      reason: terminal?.reason ?? null,
      summary: typeof terminal?.taskResultSummary === "string" ? terminal.taskResultSummary : null,
    },
    correctness: correctness && correctness.advisory === true ? {
      mechanism: correctness.mechanism ?? null,
      gate: correctness.gate ?? null,
      verdict: correctness.verdict ?? "unknown",
      agreement: correctness.agreement ?? 0,
      samples: correctness.samples ?? 0,
    } : null,
    grade: { grade: grade.grade, provenance: grade.provenance, correctness: grade.correctness, trustworthy: grade.trustworthy },
  };
  const artifactId = await sha256Hex(canonical(body));
  return { artifactId, body };
}

/**
 * Standalone re-verifier. Given ONLY an artifact ({ artifactId, body }),
 * confirm: (1) the content hash matches the id (integrity, non-forgeable id);
 * (2) the correlation triple is well-formed; (3) the grade recomputes to the
 * same weakest-wins value (the grade was not laundered upward). Needs no run,
 * no DO, no network. Fail closed on any mismatch.
 * @returns {Promise<{ ok:boolean, checks:object, reason?:string }>}
 */
export async function verifyReceiptArtifact(artifact) {
  const checks = { schema: false, contentHash: false, triple: false, gradeConsistent: false };
  try {
    const { artifactId, body } = artifact || {};
    if (!body || body.schema !== ARTIFACT_SCHEMA) return fail(checks, "bad-schema");
    checks.schema = true;

    const recomputed = await sha256Hex(canonical(body));
    if (recomputed !== artifactId) return fail(checks, "content-hash-mismatch");
    checks.contentHash = true;

    const c = body.contract || {};
    const TRIPLE = /^[A-Za-z0-9_-]{1,128}$/;
    if (!TRIPLE.test(c.runId || "") || !TRIPLE.test(c.taskFingerprint || "") || !TRIPLE.test(c.nonce || "")) {
      return fail(checks, "malformed-triple");
    }
    checks.triple = true;

    // Recompose the grade from the artifact's own provenance + correctness and
    // confirm it equals the stored grade. A tampered "trusted" grade over a
    // missing provenance is caught here (weakest-wins recompute disagrees).
    const corr = body.correctness ? { advisory: true, verdict: body.correctness.verdict } : null;
    const g = composeTrustGrade({ provenance: body.terminal?.taskContractStatus, correctness: corr });
    if (!body.grade || g.grade !== body.grade.grade || g.trustworthy !== body.grade.trustworthy) {
      return fail(checks, "grade-inconsistent");
    }
    checks.gradeConsistent = true;

    return { ok: true, checks };
  } catch (e) {
    return fail(checks, `verify-error:${String(e.message || e).slice(0, 80)}`);
  }
}

function fail(checks, reason) { return { ok: false, checks, reason }; }

export const _internals = { canonical, sha256Hex, ARTIFACT_SCHEMA };
