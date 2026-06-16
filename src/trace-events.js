const EVENT_TYPES = new Set([
  "planned", "detector_started", "detector_finished", "replay_started", "replay_finished",
  "finding_classified", "finding_published", "fix_started", "patch_rejected", "patch_accepted",
  "tests_passed", "post_fix_replay_contained", "merged", "stopped",
]);

export function publicTraceEvent(type, detail = {}, at = new Date().toISOString()) {
  if (!EVENT_TYPES.has(type)) throw new Error(`unknown trace event: ${type}`);
  const safe = {};
  if (typeof detail.scenario === "string") safe.scenario = detail.scenario.slice(0, 100);
  if (typeof detail.verdict === "string") safe.verdict = detail.verdict.slice(0, 30);
  if (typeof detail.issueUrl === "string" && /^https:\/\/github\.com\/acoyfellow\/terrarium\/issues\/\d+$/.test(detail.issueUrl)) safe.issueUrl = detail.issueUrl;
  if (typeof detail.prUrl === "string" && /^https:\/\/github\.com\/acoyfellow\/terrarium\/pull\/\d+$/.test(detail.prUrl)) safe.prUrl = detail.prUrl;
  if (typeof detail.revision === "string" && /^[a-f0-9]{40}$/i.test(detail.revision)) safe.revision = detail.revision;
  if (typeof detail.message === "string") safe.message = detail.message.replace(/(?:token|secret|password|authorization)\s*[:=]\s*\S+/gi, "[REDACTED]").slice(0, 240);
  return { type, at, ...safe };
}

export function appendTraceEvent(trace, event) {
  const events = [...(trace?.events || []), event].slice(-100);
  return { ...(trace || {}), status: event.type === "stopped" ? "stopped" : event.type === "merged" ? "healed" : "running", events, updatedAt: event.at };
}

export { EVENT_TYPES };
