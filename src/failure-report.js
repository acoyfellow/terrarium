// Failure -> bug-report pipeline (core feature).
//
// Terrarium's honesty contract already catches failures: a child whose process
// exits without a trusted, contract-matching receipt is marked failed, never a
// win. This module turns one such caught failure into a STRUCTURED, deduped bug
// report so a caught failure is not just observed — it becomes a filed artifact
// an operator (or an outer loop) can triage without re-deriving what happened.
//
// Pure + deterministic: classify() and buildFailureReport() take a terminal run
// record (the shape getRunStatus()/cloudStatus() return) plus its log text and
// return a report object. Persistence is a thin, separate step so the core
// stays testable with no filesystem.
//
// Design mirrors finding-pipeline.js: a stable dedupeSignature, an evidence
// digest, and one JSON file per report under ~/.terrarium.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const FAILURE_REPORT_DIR = join(homedir(), ".terrarium", "failure-reports");

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// The runner's exit-code taxonomy (scripts/terrarium-runner). Mapping exit code
// + terminal reason to a stable failure class is what lets the same underlying
// defect dedupe across runs regardless of which run hit it.
const RUNNER_EXIT_CLASS = {
  1: { class: "runner-setup", title: "runner setup failed (missing/invalid task or contract file)", blameHint: "backend" },
  2: { class: "model-config", title: "model/provider config missing or invalid", blameHint: "backend" },
  3: { class: "agent-missing", title: "no agent binary present in image", blameHint: "image" },
  4: { class: "receipt-absent", title: "agent emitted no TERRARIUM_RESULT= receipt line", blameHint: "agent" },
  5: { class: "receipt-ambiguous", title: "agent emitted multiple TERRARIUM_RESULT= receipt lines", blameHint: "agent" },
  6: { class: "receipt-mismatch", title: "receipt did not match the run contract", blameHint: "agent" },
  7: { class: "receipt-malformed", title: "receipt JSON was malformed or out of bounds", blameHint: "agent" },
  8: { class: "receipt-invalid", title: "receipt validation failed (unclassified)", blameHint: "agent" },
  9: { class: "node-missing", title: "node not present for receipt validation", blameHint: "image" },
  10: { class: "timeout-supervisor-missing", title: "timeout supervisor missing in image", blameHint: "image" },
  11: { class: "ca-trust", title: "NODE_EXTRA_CA_CERTS missing/invalid for HTTPS interception", blameHint: "backend" },
  124: { class: "agent-timeout", title: "agent exceeded the bounded time budget", blameHint: "agent" },
};

// A finer receipt-mismatch sub-reason is recoverable from the log line the
// runner prints, e.g. "mismatch:runId" / "malformed:extra-keys:foo". Surfacing
// it keeps two different mismatch causes from colliding in one dedupe bucket.
function extractRunnerDetail(logText) {
  if (typeof logText !== "string") return null;
  const m = logText.match(/receipt (?:did not match contract|malformed) \(([^)]+)\)/);
  if (m) return m[1];
  return null;
}

/**
 * Classify a terminal run record into a stable failure class.
 * @param {object} run terminal status record (getRunStatus/cloudStatus shape)
 * @param {string} [logText] the run's tail log
 * @returns {{failed:boolean, class:string, title:string, blameHint:string, detail:(string|null), exitCode:(number|null), reason:(string|null), contractStatus:(string|null)}}
 */
export function classifyFailure(run, logText = "") {
  const status = run?.status;
  const ok = run?.ok;
  const terminalStatuses = new Set(["failed", "error", "inconclusive"]);
  const contractStatus = run?.taskContractStatus ?? run?.terminal?.taskContractStatus ?? null;
  const exitCode = run?.exitCode ?? run?.terminal?.exitCode ?? null;
  const reason = run?.reason ?? run?.terminal?.reason ?? null;

  // A run is report-worthy when it is terminal-and-not-a-trusted-win. That is
  // either an explicit failed/error/inconclusive status, OR a done/cancelled
  // status whose task contract was never verified (ok=false). This is the same
  // honesty rule the status table encodes: exit 0 != task success.
  const notTrustedWin = ok === false || (contractStatus != null && contractStatus !== "verified" && contractStatus !== "not-required" && contractStatus !== "not-applicable");
  const failed = terminalStatuses.has(status) || (["done", "completed", "cancelled"].includes(status) && notTrustedWin);

  const detail = extractRunnerDetail(logText);
  const byExit = exitCode != null ? RUNNER_EXIT_CLASS[exitCode] : null;

  let cls, title, blameHint;
  if (byExit) {
    cls = byExit.class; title = byExit.title; blameHint = byExit.blameHint;
    // refine mismatch/malformed with the sub-reason
    if (detail && (cls === "receipt-mismatch" || cls === "receipt-malformed")) {
      title = `${title}: ${detail}`;
    }
  } else if (reason === "receipt-missing") {
    cls = "receipt-absent"; title = "terminal callback carried no trusted receipt"; blameHint = "agent";
  } else if (status === "poll-timeout") {
    cls = "poll-timeout"; title = "run did not reach terminal within the poll window"; blameHint = "backend";
  } else if (!failed) {
    cls = "not-a-failure"; title = "run is a trusted success or still running"; blameHint = "none";
  } else {
    cls = "unclassified"; title = `terminal failure (status=${status ?? "?"})`; blameHint = "unknown";
  }

  return { failed, class: cls, title, blameHint, detail: detail ?? null, exitCode: exitCode ?? null, reason: reason ?? null, contractStatus };
}

// Redact obvious secret-ish tokens from a log excerpt before it lands in a
// persisted report. Conservative: bearer tokens and long hex/secret runs.
function redact(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/\b[a-f0-9]{40,}\b/g, "[redacted-hex]")
    .replace(/([A-Za-z0-9_-]*(?:token|secret|key|password)[A-Za-z0-9_-]*)\s*[=:]\s*\S+/gi, "$1=[redacted]");
}

// Keep the log excerpt bounded so a report is a triage artifact, not a full
// log dump. Head + tail preserves the task framing and the terminal verdict.
function excerpt(logText, { headLines = 8, tailLines = 24 } = {}) {
  if (typeof logText !== "string" || logText === "") return "";
  const lines = logText.split("\n");
  if (lines.length <= headLines + tailLines) return redact(logText).trimEnd();
  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  return redact([...head, `... [${lines.length - headLines - tailLines} lines elided] ...`, ...tail].join("\n")).trimEnd();
}

/**
 * Build a structured failure report from a terminal run record + its log.
 * Pure: no I/O. Returns null when the run is not report-worthy.
 */
export function buildFailureReport(run, logText = "", { source = "manual", now = () => new Date() } = {}) {
  const classification = classifyFailure(run, logText);
  if (!classification.failed) return null;

  const runId = run?.runId ?? "(unknown)";
  const cloud = run?.cloud === true;
  // Dedupe on the DEFECT, not the run: same class + sub-detail + blame collapses
  // repeated hits of one bug into a single bucket. runId/timestamp deliberately
  // excluded so N runs failing the same way share one signature.
  const dedupeSignature = digest({
    class: classification.class,
    detail: classification.detail,
    exitCode: classification.exitCode,
    reason: classification.reason,
    blameHint: classification.blameHint,
  });

  const createdAt = now().toISOString();
  const report = {
    version: 1,
    reportId: `failrep_${classification.class}_${Date.parse(createdAt)}`,
    runId,
    cloud,
    source,
    classification,
    title: classification.title,
    blameHint: classification.blameHint,
    status: run?.status ?? null,
    ok: run?.ok ?? null,
    taskContractStatus: classification.contractStatus,
    taskFingerprint: run?.taskFingerprint ?? run?.terminal?.taskFingerprint ?? null,
    channel: run?.channel ?? null,
    workflowId: run?.workflowId ?? null,
    logExcerpt: excerpt(logText),
    dedupeSignature,
    createdAt,
  };
  report.evidenceDigest = digest({ ...report, evidenceDigest: undefined });
  return report;
}

/**
 * Persist a report, collapsing duplicates. When a prior report with the same
 * dedupeSignature exists, increments its occurrence count + records the newest
 * runId instead of writing a second file. Returns { report, path, duplicate, occurrences }.
 */
export async function persistFailureReport(report, { reportDir = FAILURE_REPORT_DIR } = {}) {
  if (!report) return null;
  await mkdir(reportDir, { recursive: true });
  const existing = await findDuplicateReport(report.dedupeSignature, { reportDir });
  if (existing) {
    const occurrences = (existing.occurrences ?? 1) + 1;
    const merged = {
      ...existing,
      occurrences,
      lastRunId: report.runId,
      lastSeenAt: report.createdAt,
      seenRunIds: Array.from(new Set([...(existing.seenRunIds ?? [existing.runId]), report.runId])).slice(-20),
    };
    const path = join(reportDir, `${existing.reportId}.json`);
    await writeFile(path, JSON.stringify(merged, null, 2) + "\n");
    return { report: merged, path, duplicate: true, occurrences };
  }
  const seeded = { ...report, occurrences: 1, seenRunIds: [report.runId], lastRunId: report.runId, lastSeenAt: report.createdAt };
  const path = join(reportDir, `${report.reportId}.json`);
  await writeFile(path, JSON.stringify(seeded, null, 2) + "\n", { flag: "wx" });
  return { report: seeded, path, duplicate: false, occurrences: 1 };
}

export async function findDuplicateReport(signature, { reportDir = FAILURE_REPORT_DIR } = {}) {
  await mkdir(reportDir, { recursive: true });
  for (const file of await readdir(reportDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await readFile(join(reportDir, file), "utf8"));
      if (value.dedupeSignature === signature) return value;
    } catch { /* skip unreadable/partial */ }
  }
  return null;
}

// Render a report as a Markdown bug report matching docs/BUGREPORT-*.md tone.
export function renderFailureReportMarkdown(report) {
  if (!report) return "";
  const c = report.classification;
  const lines = [
    `# Terrarium failure report — ${report.classification.class}`,
    "",
    `- **Report ID:** ${report.reportId}`,
    `- **Run:** ${report.runId}${report.cloud ? " (cloud)" : ""}`,
    `- **Class:** ${c.class}${c.detail ? ` (${c.detail})` : ""}`,
    `- **Blame hint:** ${report.blameHint}`,
    `- **Status / contract:** ${report.status} / ${report.taskContractStatus ?? "-"}`,
    report.classification.exitCode != null ? `- **Exit code:** ${report.classification.exitCode}` : null,
    report.classification.reason ? `- **Reason:** ${report.classification.reason}` : null,
    report.occurrences ? `- **Occurrences:** ${report.occurrences}${report.seenRunIds ? ` across ${report.seenRunIds.length} run(s)` : ""}` : null,
    `- **First seen:** ${report.createdAt}`,
    report.lastSeenAt && report.lastSeenAt !== report.createdAt ? `- **Last seen:** ${report.lastSeenAt}` : null,
    "",
    `## What failed`,
    "",
    report.title,
    "",
    `## Log excerpt`,
    "",
    "```",
    report.logExcerpt || "(no log captured)",
    "```",
    "",
    `<!-- dedupeSignature: ${report.dedupeSignature} -->`,
    `<!-- evidenceDigest: ${report.evidenceDigest} -->`,
  ].filter((l) => l !== null);
  return lines.join("\n");
}
