// Pure, side-effect-free formatters that turn the JSON shapes returned by
// listRuns() and getRunStatus() into a compact human-readable view for
// operators scanning `terra status` at a glance.
//
// Honesty contract: a run's process `status` (running/done/failed/cancelled/
// orphaned/...) describes liveness, NOT task success. Terrarium's whole point
// is that a zero-exit child with a missing/mismatched receipt is inconclusive,
// not a win. So the table surfaces `taskContractStatus` as a SEPARATE column
// and never collapses it into the liveness column. A terminated run whose
// contract was normalized to "not-applicable" must never read as verified.

const MAX_TASK_WIDTH = 48;

// Single source of truth for the liveness glyph. Active vs terminal vs error
// is what an operator triages first; the glyph is intentionally ASCII so it is
// safe in any terminal / log capture and stable to assert in tests.
export function livenessGlyph(run) {
  if (!run || typeof run !== "object") return "?";
  const status = run.status;
  if (status === "running") return run.alive === false ? "~" : "*"; // live vs stale-but-running
  if (status === "done" || status === "completed") return run.ok === false ? "x" : "+";
  if (status === "inconclusive") return "?";
  if (status === "cancelled") return "/";
  if (status === "orphaned") return "!";
  if (status === "failed" || status === "error") return "x";
  return "?";
}

// Task-contract truth, kept deliberately distinct from liveness. We only label
// a run "verified" when the field literally says so; everything else maps to a
// neutral token. This is the column that prevents a cancelled/deadlined run
// from masquerading as a task win.
export function contractLabel(run) {
  const c = run?.taskContractStatus;
  if (c === "verified") return "verified";
  if (c === "violated") return "violated";
  if (c === "not-applicable") return "n/a";
  if (typeof c === "string" && c.length) return c;
  return "-";
}

function clip(value, width) {
  const s = value == null ? "" : String(value).replace(/\s+/g, " ").trim();
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return `${s.slice(0, width - 1)}\u2026`; // ellipsis
}

function pad(value, width) {
  const s = value == null ? "" : String(value);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// Compact one-line summary for a single run record. Stable column order:
// glyph, runId, liveness status, task-contract, short task. Used by both the
// table renderer and the single-run `terra status <runId>` summary so the two
// can never drift in how they describe the same record.
export function formatRunLine(run, { taskWidth = MAX_TASK_WIDTH } = {}) {
  const glyph = livenessGlyph(run);
  const runId = run?.runId ?? "(unknown)";
  const status = run?.status ?? "unknown";
  const contract = contractLabel(run);
  const task = clip(run?.task, taskWidth);
  return `${glyph} ${pad(runId, 30)} ${pad(status, 12)} ${pad(contract, 10)} ${task}`.trimEnd();
}

// Render the full listRuns() result as a header + per-run lines. Returns a
// string; printing is the caller's concern so this stays pure and testable.
export function formatRunList(result, { taskWidth = MAX_TASK_WIDTH } = {}) {
  if (!result || typeof result !== "object") return "terrarium status: no data";
  const runs = Array.isArray(result.runs) ? result.runs : [];
  const lines = [];
  const active = Number(result.activeCount) || 0;
  const shown = runs.length;
  lines.push(`terrarium ${result.version ?? ""}  active ${active}  shown ${shown}`.trim());
  if (result.logDir) lines.push(`log dir: ${result.logDir}`);
  if (shown === 0) {
    lines.push("(no visible runs)");
    return lines.join("\n");
  }
  lines.push(`${pad("S", 1)} ${pad("run", 30)} ${pad("status", 12)} ${pad("contract", 10)} task`);
  for (const run of runs) lines.push(formatRunLine(run, { taskWidth }));
  lines.push("");
  lines.push("legend: + done.ok  x failed/error  / cancelled  ! orphaned  * running  ~ running(stale)  ? inconclusive/unknown");
  lines.push("note: 'status' is liveness; 'contract' is task truth (verified means a trusted receipt, not just exit 0).");
  return lines.join("\n");
}

// Single-run summary header that reuses the same line formatter, then appends
// the few extra operator-relevant facts (timing, exit, attention) when present.
export function formatRunStatus(run, { taskWidth = MAX_TASK_WIDTH } = {}) {
  if (!run || typeof run !== "object") return "terrarium status: no run";
  const lines = [formatRunLine(run, { taskWidth })];
  const detail = [];
  if (run.exitCode != null) detail.push(`exit ${run.exitCode}`);
  if (run.signal) detail.push(`signal ${run.signal}`);
  if (run.startedAt) detail.push(`started ${run.startedAt}`);
  if (run.finishedAt) detail.push(`finished ${run.finishedAt}`);
  if (run.needsAttention) detail.push("NEEDS-ATTENTION");
  if (detail.length) lines.push(`  ${detail.join("  ")}`);
  if (run.note) lines.push(`  note: ${run.note}`);
  if (run.reason) lines.push(`  reason: ${run.reason}`);
  return lines.join("\n");
}
