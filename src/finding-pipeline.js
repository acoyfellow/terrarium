import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runParameterizedProbe } from "./parameterized-probes.js";

export const FINDING_DIR = join(homedir(), ".terrarium", "findings");

function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function classifyProbe(probeId) {
  if (probeId === "interpreter-proxy-exec") return { kind: "boundary-clarification", severity: "informational", publishIssue: false, reason: "noexec prevents direct execution, not an allowed interpreter reading code as data" };
  return { kind: "product-defect", severity: probeId === "encoding-evasion-leak" ? "high" : "medium", publishIssue: true };
}

export async function verifyProbeFinding(probeId, { findingDir = FINDING_DIR, traceRunId = null } = {}) {
  const first = await runParameterizedProbe(probeId);
  const replay = first.verdict === "escaped" ? await runParameterizedProbe(probeId) : null;
  const verified = first.verdict === "escaped" && replay?.verdict === "escaped";
  const classification = classifyProbe(probeId);
  const evidence = {
    version: 1, findingId: `finding_${probeId}_${Date.now()}`, probeId,
    fixture: false, synthetic: false,
    classification,
    first, replay,
    verdict: verified ? "verified-escape" : first.verdict,
    traceRunId,
    createdAt: new Date().toISOString(),
  };
  evidence.dedupeSignature = digest({ probeId, kind: classification.kind, first: first.observed, replay: replay?.observed });
  evidence.evidenceDigest = digest(evidence);
  await mkdir(findingDir, { recursive: true });
  const path = join(findingDir, `${evidence.findingId}.json`);
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  return { ...evidence, path };
}

export async function findDuplicate(signature, { findingDir = FINDING_DIR } = {}) {
  await mkdir(findingDir, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  for (const file of await readdir(findingDir)) {
    if (!file.endsWith(".json")) continue;
    const value = JSON.parse(await readFile(join(findingDir, file), "utf8"));
    if (value.dedupeSignature === signature) return value;
  }
  return null;
}

export function sanitizedFinding(evidence) {
  return {
    findingId: evidence.findingId,
    probeId: evidence.probeId,
    verdict: evidence.verdict,
    classification: evidence.classification,
    observed: evidence.first.observed,
    replayObserved: evidence.replay?.observed || null,
    evidenceDigest: evidence.evidenceDigest,
    dedupeSignature: evidence.dedupeSignature,
    traceRunId: evidence.traceRunId,
    createdAt: evidence.createdAt,
  };
}
