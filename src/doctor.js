import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { CONFIG_PATH, EVENT_DIR, HOME, LOG_DIR, WORKSPACE_DIR, listRuns } from "./core.js";
import { GROUP_DIR } from "./groups.js";
import { JOURNAL_DIR, MAILBOXES_DIR, ROUTER_DIR, SUBSCRIBERS_DIR } from "./router.js";

async function writable(path) {
  try { await mkdir(path, { recursive: true }); await access(path, constants.R_OK | constants.W_OK); return true; } catch { return false; }
}
async function count(path, filter = () => true) { try { return (await readdir(path)).filter(filter).length; } catch { return 0; } }
async function jsonHealth(path, validate = () => true) {
  let valid = 0, malformed = 0;
  try {
    for (const file of (await readdir(path)).filter((name) => name.endsWith(".json"))) {
      try {
        const value = JSON.parse(await readFile(`${path}/${file}`, "utf8"));
        if (!validate(value, file)) throw new Error("invalid record");
        valid++;
      } catch { malformed++; }
    }
  } catch {}
  return { valid, malformed };
}
const validOwner = (value) => value === null || (typeof value === "string" && /^ter_[A-Za-z0-9_]+$/.test(value));
const SUBSCRIBER_KEYS = new Set(["version", "subscriberId", "channels", "workflowIds", "eventTypes", "runIds", "ownerRunId", "createdAt", "updatedAt"]);
const CALLBACK_KEYS = new Set(["type", "eventId", "runId", "parentRunId", "taskFingerprint", "workflowId", "sessionId", "channel", "at", "status", "ok", "exitCode", "signal", "dryRun", "claimedAt"]);
const TERMINAL_TYPES = new Set(["Completed", "Failed", "TimedOut", "Cancelled"]);
const hasOnlyKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.has(key));
const validSubscriber = (value, file) => hasOnlyKeys(value, SUBSCRIBER_KEYS) && value.subscriberId === file.slice(0, -5) && Object.hasOwn(value, "ownerRunId") && validOwner(value.ownerRunId);
const validEvent = (value, file) => hasOnlyKeys(value, CALLBACK_KEYS) && value.eventId === file.slice(0, -5) && TERMINAL_TYPES.has(value.type) && typeof value.runId === "string";
async function mailboxHealth(path) {
  let valid = 0, malformed = 0;
  try {
    for (const file of (await readdir(path)).filter((name) => name.endsWith(".json"))) {
      try {
        const value = JSON.parse(await readFile(`${path}/${file}`, "utf8"));
        if (!validEvent(value, file)) throw new Error("invalid callback");
        valid++;
      } catch { malformed++; }
    }
  } catch {}
  return { valid, malformed };
}

export async function diagnoseTerrarium() {
  const runs = await listRuns({ limit: 100 });
  const subscriberHealth = await jsonHealth(SUBSCRIBERS_DIR, validSubscriber);
  const journalHealth = await jsonHealth(JOURNAL_DIR, validEvent);
  const checks = {
    homeWritable: await writable(HOME),
    logsWritable: await writable(LOG_DIR),
    workspaceWritable: await writable(WORKSPACE_DIR),
    routerWritable: await writable(ROUTER_DIR),
    configPresent: existsSync(CONFIG_PATH),
    activeRuns: runs.activeCount,
    orphanedRuns: runs.runs.filter((run) => run.status === "orphaned").length,
    needsAttentionRuns: runs.runs.filter((run) => run.needsAttention === true).length,
    groups: await count(GROUP_DIR, (file) => file.endsWith(".json")),
    subscribers: subscriberHealth.valid,
    malformedSubscribers: subscriberHealth.malformed,
    journalEvents: journalHealth.valid,
    malformedJournalEvents: journalHealth.malformed,
    pendingCallbacks: 0,
    malformedPendingCallbacks: 0,
    inflightCallbacks: 0,
    malformedInflightCallbacks: 0,
    missingTerminalCallbacks: 0,
    staleChildClaims: 0,
  };
  for (const run of runs.runs) {
    if (["running", "orphaned"].includes(run.status)) continue;
    const type = run.status === "cancelled" ? "Cancelled" : run.ok ? "Completed" : "Failed";
    if (!existsSync(`${JOURNAL_DIR}/evt_${run.runId}_${type}.json`)) checks.missingTerminalCallbacks++;
  }
  try {
    for (const subscriber of await readdir(MAILBOXES_DIR)) {
      const pending = await mailboxHealth(`${MAILBOXES_DIR}/${subscriber}/pending`);
      const inflight = await mailboxHealth(`${MAILBOXES_DIR}/${subscriber}/inflight`);
      checks.pendingCallbacks += pending.valid;
      checks.malformedPendingCallbacks += pending.malformed;
      checks.inflightCallbacks += inflight.valid;
      checks.malformedInflightCallbacks += inflight.malformed;
    }
  } catch {}
  try {
    for (const entry of await readdir(LOG_DIR)) if (entry.endsWith(".children")) {
      const dir = `${LOG_DIR}/${entry}`;
      let slots = []; try { slots = await readdir(dir); } catch { continue; }
      for (const slot of slots) {
        let childId = ""; try { childId = (await readFile(`${dir}/${slot}`, "utf8")).trim(); } catch {}
        if (!childId || !existsSync(`${LOG_DIR}/${childId}.json`)) checks.staleChildClaims++;
      }
    }
  } catch {}
  const warnings = [];
  if (!checks.homeWritable || !checks.logsWritable || !checks.workspaceWritable || !checks.routerWritable) warnings.push("Terrarium storage is not readable/writable");
  if (checks.orphanedRuns) warnings.push(`${checks.orphanedRuns} orphaned run(s) need inspection`);
  if (checks.needsAttentionRuns) warnings.push(`${checks.needsAttentionRuns} active run(s) need attention`);
  if (checks.malformedSubscribers) warnings.push(`${checks.malformedSubscribers} malformed subscriber record(s) need quarantine or repair`);
  if (checks.malformedJournalEvents) warnings.push(`${checks.malformedJournalEvents} malformed callback journal event(s) need quarantine or repair`);
  if (checks.pendingCallbacks) warnings.push(`${checks.pendingCallbacks} callback(s) are pending delivery`);
  if (checks.malformedPendingCallbacks) warnings.push(`${checks.malformedPendingCallbacks} malformed pending callback(s) need quarantine or repair`);
  if (checks.inflightCallbacks) warnings.push(`${checks.inflightCallbacks} callback(s) are claimed but unacknowledged`);
  if (checks.malformedInflightCallbacks) warnings.push(`${checks.malformedInflightCallbacks} malformed inflight callback(s) need quarantine or repair`);
  if (checks.missingTerminalCallbacks) warnings.push(`${checks.missingTerminalCallbacks} terminal run(s) are missing durable callback events; recover those run IDs`);
  if (checks.staleChildClaims) warnings.push(`${checks.staleChildClaims} stale child-slot claim(s) exist from older runs`);
  return { ok: warnings.length === 0, checks, warnings, paths: { home: HOME, logs: LOG_DIR, workspaces: WORKSPACE_DIR, events: EVENT_DIR, router: ROUTER_DIR } };
}
