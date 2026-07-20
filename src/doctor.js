import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { CONFIG_PATH, EVENT_DIR, HOME, LOG_DIR, WORKSPACE_DIR, VERSION, ensureTerminalCallback, listRuns, pruneStaleChildClaims } from "./core.js";
import { requeueInflightEvents } from "./router.js";
import { BATCH_API_VERSION, BATCH_SUPPORTED_OPTIONS, MCP_SCHEMA_VERSION, TERRARIUM_API_VERSION } from "./versions.js";
import { GROUP_DIR } from "./groups.js";
import { JOURNAL_DIR, MAILBOXES_DIR, ROUTER_DIR, SUBSCRIBERS_DIR } from "./router.js";
import { cloudEnabled, pulseEnabled } from "./cloud-client.js";

// Stale-cloud-env: a session configured for cloud execution (TERRARIUM_URL +
// control token) but WITHOUT a pulse token cannot receive a background cloud
// run's terminal callback — the DO emits it into the cloud Pulse mailbox, but
// this session never subscribes/claims it, so the driver waits forever. This is
// the delivery-path failure behind issue #18 (missing callback despite verified
// receipt) and the looprunner/my.ax stale-MCP-env incidents. Detected from real
// config, not a guess: cloud on + pulse off.
function diagnoseCloudEnv(env = process.env) {
  const cloud = cloudEnabled(env);
  const pulse = pulseEnabled(env);
  return {
    cloudConfigured: cloud,
    pulseConfigured: pulse,
    // The dangerous combination: cloud runs will execute but their terminal
    // callbacks cannot be delivered to this session.
    cloudCallbacksUndeliverable: cloud && !pulse,
  };
}

// Stale-MCP-process-env: the long-lived MCP process caches process.env from the
// moment it was spawned. If the operator later configures cloud execution (writes
// a cloudUrl into config.json, or exports TERRARIUM_URL in a fresh shell) WITHOUT
// restarting the MCP process, this running process still has the OLD env — it will
// silently execute locally while the session believes it is on cloud. The fix is
// always `/reload`. We detect it structurally: the persisted config on disk
// records a cloudUrl, but this process's TERRARIUM_URL is absent or different.
// Read from disk fresh (not the cached load) so the comparison reflects reality.
async function diagnoseStaleCloudEnv(env = process.env) {
  let configuredUrl = "";
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    configuredUrl = typeof cfg.cloudUrl === "string" ? cfg.cloudUrl.replace(/\/$/, "") : "";
  } catch { /* no config or unreadable: nothing persisted to compare against */ }
  if (!configuredUrl) return { staleCloudEnv: false, configuredCloudUrl: null, processCloudUrl: null };
  const processUrl = typeof env.TERRARIUM_URL === "string" ? env.TERRARIUM_URL.replace(/\/$/, "") : "";
  // Since cloudConfig() now falls back to config.json when the env var is
  // absent, an EMPTY process TERRARIUM_URL is no longer stale — the file
  // resolves the same cloudUrl in-process. Only a process env that points at a
  // DIFFERENT url is genuinely stale (it overrides the file and disagrees).
  const staleCloudEnv = processUrl !== "" && processUrl !== configuredUrl;
  return {
    staleCloudEnv,
    configuredCloudUrl: configuredUrl,
    processCloudUrl: processUrl || null,
  };
}

async function writable(path) {
  try { await mkdir(path, { recursive: true }); await access(path, constants.R_OK | constants.W_OK); return true; } catch { return false; }
}
async function count(path, filter = () => true) { try { return (await readdir(path)).filter(filter).length; } catch { return 0; } }
// Workspace footprint: isolation copy|worktree workspaces should be GC'd at
// terminal unless keepWorkspace. A large or growing WORKSPACE_DIR is the 31GB
// monorepo-copy leak from BUGREPORT-2026-07-01; surfacing bytes + a leaked count
// (workspaces whose run is already terminal) makes silent recurrence visible.
async function workspaceFootprint() {
  let dirs = 0, bytes = 0, leaked = 0;
  const { stat } = await import("node:fs/promises");
  let entries = [];
  try { entries = await readdir(WORKSPACE_DIR, { withFileTypes: true }); } catch { return { workspaceDirs: 0, workspaceBytes: 0, leakedWorkspaces: 0 }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    dirs++;
    const full = `${WORKSPACE_DIR}/${e.name}`;
    // Bounded byte sum: one level of du to keep doctor O(dirs), not O(all files).
    try { const s = await stat(full); bytes += s.size; } catch {}
    // A workspace dir named <runId>-<name> whose run metadata is terminal is a
    // leak candidate: cleanup should have removed it unless keepWorkspace.
    const runId = e.name.replace(/-[^-]*$/, "");
    if (/^ter_[A-Za-z0-9_]+$/.test(runId)) {
      try {
        const meta = JSON.parse(await readFile(`${LOG_DIR}/${runId}.json`, "utf8"));
        if (meta.status && !["running", "accepted"].includes(meta.status) && meta.keepWorkspace !== true) leaked++;
      } catch { /* no metadata: orphan workspace, also a leak candidate */ leaked++; }
    }
  }
  return { workspaceDirs: dirs, workspaceBytes: bytes, leakedWorkspaces: leaked };
}
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
const CALLBACK_KEYS = new Set(["type", "eventId", "runId", "parentRunId", "taskFingerprint", "workflowId", "sessionId", "channel", "at", "status", "ok", "exitCode", "signal", "dryRun", "claimedAt", "receipt", "deliveryAttempts"]);
const TERMINAL_TYPES = new Set(["Completed", "Failed", "TimedOut", "Cancelled"]);
const hasOnlyKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => keys.has(key));
const validTimestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const validSubscriber = (value, file) => hasOnlyKeys(value, SUBSCRIBER_KEYS) && validId(value.subscriberId) && value.subscriberId === file.slice(0, -5) && Object.hasOwn(value, "ownerRunId") && validOwner(value.ownerRunId) && validTimestamp(value.createdAt) && validTimestamp(value.updatedAt);
const validDeliveryAttempts = (value) => value === undefined || (Number.isInteger(value) && value >= 0 && value <= 1_000_000);
const validEvent = (value, file) => hasOnlyKeys(value, CALLBACK_KEYS) && validId(value.eventId) && value.eventId === file.slice(0, -5) && TERMINAL_TYPES.has(value.type) && typeof value.runId === "string" && validTimestamp(value.at) && validDeliveryAttempts(value.deliveryAttempts);
const validPendingEvent = (value, file) => validEvent(value, file) && !Object.hasOwn(value, "claimedAt");
const validClaimedEvent = (value, file) => validEvent(value, file) && Object.hasOwn(value, "claimedAt") && validTimestamp(value.claimedAt);
async function mailboxHealth(path, validate) {
  let valid = 0, malformed = 0;
  try {
    for (const file of (await readdir(path)).filter((name) => name.endsWith(".json"))) {
      try {
        const value = JSON.parse(await readFile(`${path}/${file}`, "utf8"));
        if (!validate(value, file)) throw new Error("invalid callback");
        valid++;
      } catch { malformed++; }
    }
  } catch {}
  return { valid, malformed };
}

export async function diagnoseTerrarium() {
  const runs = await listRuns({ limit: 100 });
  const details = {
    activeRunIds: runs.activeRunIds ?? [],
    orphanedRunIds: runs.runs.filter((run) => run.status === "orphaned").map((run) => run.runId),
    needsAttentionRunIds: runs.runs.filter((run) => run.needsAttention === true).map((run) => run.runId),
    missingTerminalCallbackRunIds: [],
    staleInflightCallbackSubscriberIds: [],
    staleChildClaims: [],
  };
  const subscriberHealth = await jsonHealth(SUBSCRIBERS_DIR, validSubscriber);
  const journalHealth = await jsonHealth(JOURNAL_DIR, validEvent);
  const workspace = await workspaceFootprint();
  const checks = {
    homeWritable: await writable(HOME),
    logsWritable: await writable(LOG_DIR),
    workspaceWritable: await writable(WORKSPACE_DIR),
    routerWritable: await writable(ROUTER_DIR),
    configPresent: existsSync(CONFIG_PATH),
    activeRuns: runs.activeCount,
    orphanedRuns: details.orphanedRunIds.length,
    needsAttentionRuns: details.needsAttentionRunIds.length,
    groups: await count(GROUP_DIR, (file) => file.endsWith(".json")),
    subscribers: subscriberHealth.valid,
    malformedSubscribers: subscriberHealth.malformed,
    journalEvents: journalHealth.valid,
    malformedJournalEvents: journalHealth.malformed,
    pendingCallbacks: 0,
    malformedPendingCallbacks: 0,
    inflightCallbacks: 0,
    malformedInflightCallbacks: 0,
    acknowledgedCallbacks: 0,
    malformedAcknowledgedCallbacks: 0,
    quarantinedCallbacks: 0,
    staleInflightCallbacks: 0,
    routerRepairCandidates: subscriberHealth.malformed + journalHealth.malformed,
    missingTerminalCallbacks: 0,
    staleChildClaims: 0,
    workspaceDirs: workspace.workspaceDirs,
    workspaceBytes: workspace.workspaceBytes,
    leakedWorkspaces: workspace.leakedWorkspaces,
    ...diagnoseCloudEnv(),
    ...(await diagnoseStaleCloudEnv()),
  };
  for (const run of runs.runs) {
    if (["running", "orphaned"].includes(run.status)) continue;
    const type = run.status === "cancelled" ? "Cancelled" : run.ok ? "Completed" : "Failed";
    if (!existsSync(`${JOURNAL_DIR}/evt_${run.runId}_${type}.json`)) {
      checks.missingTerminalCallbacks++;
      details.missingTerminalCallbackRunIds.push(run.runId);
    }
  }
  try {
    for (const subscriber of await readdir(MAILBOXES_DIR)) {
      const pending = await mailboxHealth(`${MAILBOXES_DIR}/${subscriber}/pending`, validPendingEvent);
      const inflight = await mailboxHealth(`${MAILBOXES_DIR}/${subscriber}/inflight`, validClaimedEvent);
      const acknowledged = await mailboxHealth(`${MAILBOXES_DIR}/${subscriber}/acked`, validClaimedEvent);
      // Dead-lettered poison callbacks carry the pending event shape (no claimedAt).
      const dead = await mailboxHealth(`${MAILBOXES_DIR}/${subscriber}/dead`, validPendingEvent);
      checks.quarantinedCallbacks += dead.valid;
      checks.pendingCallbacks += pending.valid;
      checks.malformedPendingCallbacks += pending.malformed;
      checks.inflightCallbacks += inflight.valid;
      checks.malformedInflightCallbacks += inflight.malformed;
      checks.acknowledgedCallbacks += acknowledged.valid;
      checks.malformedAcknowledgedCallbacks += acknowledged.malformed;
      checks.routerRepairCandidates += pending.malformed + inflight.malformed + acknowledged.malformed;
      try {
        let staleHere = 0;
        for (const file of (await readdir(`${MAILBOXES_DIR}/${subscriber}/inflight`)).filter((name) => name.endsWith('.json'))) {
          let event; try { event = JSON.parse(await readFile(`${MAILBOXES_DIR}/${subscriber}/inflight/${file}`, 'utf8')); } catch { continue; }
          if (validClaimedEvent(event, file) && Date.now() - Date.parse(event.claimedAt) >= 300000) {
            checks.staleInflightCallbacks++;
            checks.routerRepairCandidates++;
            staleHere++;
          }
        }
        // Record which subscriber(s) own stale claims so the repair plan can emit
        // a runnable per-subscriber requeue step (requeue requires a subscriberId).
        if (staleHere && validId(subscriber)) details.staleInflightCallbackSubscriberIds.push(subscriber);
      } catch {}
    }
  } catch {}
  try {
    for (const entry of await readdir(LOG_DIR)) if (entry.endsWith(".children")) {
      const dir = `${LOG_DIR}/${entry}`;
      let slots = []; try { slots = await readdir(dir); } catch { continue; }
      for (const slot of slots) {
        let childId = ""; try { childId = (await readFile(`${dir}/${slot}`, "utf8")).trim(); } catch {}
        if (!/^ter_[A-Za-z0-9_]+$/.test(childId) || !existsSync(`${LOG_DIR}/${childId}.json`)) {
          checks.staleChildClaims++;
          details.staleChildClaims.push({ claimFile: `${dir}/${slot}`, childRunId: childId || null });
        }
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
  if (checks.malformedAcknowledgedCallbacks) warnings.push(`${checks.malformedAcknowledgedCallbacks} malformed acknowledged callback(s) need quarantine or repair`);
  if (checks.quarantinedCallbacks) warnings.push(`${checks.quarantinedCallbacks} poison callback(s) were quarantined after exceeding the delivery-attempt cap; inspect or prune them`);
  if (checks.staleInflightCallbacks) warnings.push(`${checks.staleInflightCallbacks} stale inflight callback(s) are repair candidates for requeue`);
  if (checks.missingTerminalCallbacks) warnings.push(`${checks.missingTerminalCallbacks} terminal run(s) are missing durable callback events; recover those run IDs`);
  if (checks.staleChildClaims) warnings.push(`${checks.staleChildClaims} stale child-slot claim(s) exist from older runs`);
  if (checks.leakedWorkspaces) warnings.push(`${checks.leakedWorkspaces} isolation workspace(s) survived a terminal run without keepWorkspace (possible workspace leak); inspect ${WORKSPACE_DIR}`);
  if (checks.cloudCallbacksUndeliverable) warnings.push("Cloud execution is configured (TERRARIUM_URL + control token) but no pulse token is set, so background cloud runs' terminal callbacks cannot reach this session; set TERRARIUM_PULSE_TOKEN(_FILE) and /reload the MCP process");
  if (checks.staleCloudEnv) warnings.push(`Stale MCP process env: config.json records cloudUrl=${checks.configuredCloudUrl} but this process's TERRARIUM_URL is ${checks.processCloudUrl ? checks.processCloudUrl : "unset"}; the running MCP process was started before cloud was configured and will execute locally — /reload the MCP process to pick up the cloud env`);
  const repairPlan = buildRepairPlan(checks, details);
  const repairPlanSummary = summarizeRepairPlan(repairPlan);
  return { ok: warnings.length === 0, version: VERSION, apiVersion: TERRARIUM_API_VERSION, schemaVersion: MCP_SCHEMA_VERSION, batchApiVersion: BATCH_API_VERSION, batchSupportedOptions: BATCH_SUPPORTED_OPTIONS, checks, details, warnings, repairPlan, repairPlanSummary, paths: { home: HOME, logs: LOG_DIR, workspaces: WORKSPACE_DIR, events: EVENT_DIR, router: ROUTER_DIR } };
}

// Map detected reconstruction signals to explicit, ready-to-run remediation steps.
// Derived purely from already-computed checks/details, so it adds no extra I/O.
function buildRepairPlan(checks, details) {
  const plan = [];
  for (const runId of details.missingTerminalCallbackRunIds) {
    plan.push({ kind: "missingTerminalCallback", runId, action: "recover", tool: "terrarium_callbacks", args: { action: "recover", runId }, reason: "Terminal run is missing its durable callback event; recover rebuilds the journal entry and mailbox fan-out." });
  }
  if (checks.staleInflightCallbacks) {
    // requeue requires a subscriberId, so emit one runnable step per affected
    // subscriber rather than a single argument-less step an agent cannot run.
    if (details.staleInflightCallbackSubscriberIds.length) {
      for (const subscriberId of details.staleInflightCallbackSubscriberIds) {
        plan.push({ kind: "staleInflightCallback", subscriberId, action: "requeue", tool: "terrarium_callbacks", args: { action: "requeue", subscriberId }, reason: "Inflight callbacks claimed but never acked past the staleness window; requeue returns them to pending for redelivery." });
      }
    } else {
      // Stale claims detected but no subscriber could be attributed (e.g. an
      // invalid mailbox directory name); flag manually without a tool handle.
      plan.push({ kind: "staleInflightCallback", count: checks.staleInflightCallbacks, action: "requeue", reason: "Inflight callbacks claimed but never acked past the staleness window, but their owning subscriber could not be attributed; requeue each affected subscriber by id out-of-band." });
    }
  }
  for (const claim of details.staleChildClaims) {
    plan.push({ kind: "staleChildClaim", claimFile: claim.claimFile, childRunId: claim.childRunId, action: "prune", tool: "terrarium_callbacks", args: { action: "prune" }, reason: "Child-slot claim points at a missing or invalid run log; prune removes every stale slot claim to free the parent budget." });
  }
  for (const runId of details.orphanedRunIds) {
    plan.push({ kind: "orphanedRun", runId, action: "inspect", tool: "terrarium_read", args: { runId }, reason: "Run lost its supervisor before recording a terminal state; inspect its log to confirm outcome, then cancel or recover." });
  }
  for (const runId of details.needsAttentionRunIds) {
    plan.push({ kind: "needsAttentionRun", runId, action: "inspect", tool: "terrarium_read", args: { runId }, reason: "Active run produced no observed output past its attention window; inspect its log to decide whether to keep waiting or cancel." });
  }
  if (checks.malformedSubscribers || checks.malformedJournalEvents || checks.malformedPendingCallbacks || checks.malformedInflightCallbacks || checks.malformedAcknowledgedCallbacks) {
    plan.push({ kind: "malformedRouterRecords", count: checks.routerRepairCandidates, action: "quarantine", reason: "Malformed router records cannot be parsed; quarantine or repair them out-of-band so doctor returns ok." });
  }
  return plan;
}

// Roll the repair plan up into an at-a-glance triage summary: total steps,
// per-action counts, and whether any step is mechanically actionable (has a
// tool a reconstructing agent can call). Manual-only steps (e.g. quarantine)
// still count toward the total but not toward `actionable`.
function summarizeRepairPlan(plan) {
  const byAction = {};
  let actionable = 0;
  for (const step of plan) {
    byAction[step.action] = (byAction[step.action] ?? 0) + 1;
    if (step.tool) actionable++;
  }
  return { total: plan.length, actionable, byAction };
}

// Repair-step kinds that are mechanically safe and idempotent to drive
// automatically: each maps to an existing durable primitive whose effect is
// reconstruction (recover/requeue) or reclaiming dead state (prune). Steps that
// require human judgement (inspecting an orphaned or stuck run) or out-of-band
// handling (quarantining malformed records) are never auto-executed; they are
// reported as skipped so the operator stays in the loop.
const SELF_HEALING_KINDS = new Set(["missingTerminalCallback", "staleInflightCallback", "staleChildClaim"]);
// Each self-healing kind maps to the diagnosis counter that a successful repair
// must drive to zero. Post-repair re-diagnosis reads these to prove the fix
// landed rather than merely ran.
const SELF_HEALING_EVIDENCE = {
  missingTerminalCallback: "missingTerminalCallbacks",
  staleInflightCallback: "staleInflightCallbacks",
  staleChildClaim: "staleChildClaims",
};
const SKIP_REASONS = {
  orphanedRun: "needs operator judgement: inspect the run log before cancelling or recovering",
  needsAttentionRun: "needs operator judgement: inspect the run log before deciding to wait or cancel",
  malformedRouterRecords: "needs out-of-band quarantine/repair of unparseable records",
};

// Drive the mechanically-safe subset of a doctor repair plan. This is a
// top-level maintenance operation over durable router/log state only; it never
// spawns, resumes, or mutates the one-child-per-run execution contract. It
// reuses the same primitives the repair plan already points agents at
// (ensureTerminalCallback, requeueInflightEvents, pruneStaleChildClaims), so an
// applied repair is identical to running each plan step by hand.
//
// Safety: dryRun defaults to true, so callers must opt in to mutation. Stale
// child-claim pruning is global (pruneStaleChildClaims reclaims every stale
// slot), so the matching steps are collapsed into a single prune action that
// runs at most once per execution. requesterRunId is rejected for the same
// reason terrarium_doctor is: self-healing is a top-level controller affordance.
//
// Evidence: pass verify:true on an applied (non-dry) run to re-diagnose after
// the repair and attach a `residual` block proving each self-healing condition
// actually cleared. A dry run never verifies (nothing changed to re-measure).
// Callers that already hold a fresh diagnosis (e.g. the CLI) may pass it as
// `baseline` so the residual evidence can report the pre-repair `before` count
// without a redundant diagnose pass; otherwise `before` is recorded as null.
export async function executeRepairPlan({ plan, dryRun = true, requesterRunId, verify = false, baseline = null } = {}) {
  if (requesterRunId) throw new Error("Terrarium repair execution is available only to a top-level controller");
  if (!baseline && !Array.isArray(plan)) baseline = await diagnoseTerrarium();
  const steps = Array.isArray(plan) ? plan : baseline.repairPlan;
  const applied = [], skipped = [];
  let prunedClaims = false;
  for (const step of steps) {
    if (!SELF_HEALING_KINDS.has(step.kind)) {
      skipped.push({ kind: step.kind, action: step.action, reason: SKIP_REASONS[step.kind] ?? "not a mechanically self-healing step" });
      continue;
    }
    try {
      if (step.kind === "missingTerminalCallback") {
        if (!step.runId) { skipped.push({ kind: step.kind, action: step.action, reason: "missing runId" }); continue; }
        if (dryRun) { applied.push({ kind: step.kind, action: "recover", runId: step.runId, dryRun: true }); continue; }
        const result = await ensureTerminalCallback({ runId: step.runId });
        applied.push({ kind: step.kind, action: "recover", runId: step.runId, dryRun: false, recovered: result?.recovered ?? null });
      } else if (step.kind === "staleInflightCallback") {
        if (!step.subscriberId) { skipped.push({ kind: step.kind, action: step.action, reason: "subscriber could not be attributed; requeue by id out-of-band" }); continue; }
        if (dryRun) { applied.push({ kind: step.kind, action: "requeue", subscriberId: step.subscriberId, dryRun: true }); continue; }
        const result = await requeueInflightEvents({ subscriberId: step.subscriberId });
        applied.push({ kind: step.kind, action: "requeue", subscriberId: step.subscriberId, dryRun: false, requeued: result?.requeued ?? 0 });
      } else if (step.kind === "staleChildClaim") {
        // pruneStaleChildClaims reclaims every stale slot in one pass, so run it
        // at most once and attribute the single result to all matching steps.
        if (prunedClaims) { applied.push({ kind: step.kind, action: "prune", claimFile: step.claimFile, dryRun, coveredByPriorPrune: true }); continue; }
        if (dryRun) { applied.push({ kind: step.kind, action: "prune", claimFile: step.claimFile, dryRun: true }); prunedClaims = true; continue; }
        const result = await pruneStaleChildClaims({});
        prunedClaims = true;
        applied.push({ kind: step.kind, action: "prune", dryRun: false, prunedCount: result?.count ?? 0 });
      }
    } catch (error) {
      skipped.push({ kind: step.kind, action: step.action, reason: `repair failed: ${error.message}` });
    }
  }
  const receipt = { ok: skipped.length === 0, dryRun, appliedCount: applied.length, skippedCount: skipped.length, applied, skipped };
  if (verify && !dryRun) receipt.residual = await verifyRepairResidual({ steps, baseline });
  return receipt;
}

// Re-diagnose after an applied repair and produce per-condition evidence that
// the self-healing steps actually drove their target counter to zero. Only the
// mechanically-safe kinds that were present in the plan are checked, so the
// evidence maps one-to-one onto what the repair claimed to fix. `verified` is
// true only when every checked condition cleared; a non-cleared counter means
// the repair ran but the underlying state was not fully reconciled (e.g. a
// callback that re-staled, or a claim a concurrent run re-took).
async function verifyRepairResidual({ steps, baseline }) {
  const kinds = new Set(steps.map((step) => step.kind).filter((kind) => SELF_HEALING_KINDS.has(kind)));
  const post = await diagnoseTerrarium();
  const conditions = [];
  for (const kind of kinds) {
    const counter = SELF_HEALING_EVIDENCE[kind];
    const before = baseline ? (baseline.checks[counter] ?? null) : null;
    const after = post.checks[counter] ?? 0;
    conditions.push({ kind, counter, before, after, cleared: after === 0 });
  }
  return { verified: conditions.every((condition) => condition.cleared), conditions };
}
