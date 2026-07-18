import { createHash } from "node:crypto";
import { cancelRun, getRunStatus, listRuns } from "./core.js";
import { getRunGroupStatus, listRunGroups } from "./groups.js";
import { acknowledgeMailboxEvent, claimMailboxEvents, registerSubscriber, requeueInflightEvents } from "./router.js";
import { pulseEnabled, cloudPulseSubscribe, cloudPulseClaim, cloudPulseAck, cloudStatus } from "./cloud-client.js";

const WIDGET = "terrarium-runs";
const TERMINAL_TYPES = ["Completed", "Failed", "TimedOut", "Cancelled"];
// A genuinely poison callback (one sendMessage always throws on) is requeued by
// the failure path below on every refresh, so without a cap it would re-claim and
// re-crash the delivery loop forever. Stop re-serving an event after this many
// recorded redeliveries: claim quarantines it to the dead-letter mailbox instead,
// and the session is notified once so the operator can inspect it via doctor.
const MAX_DELIVERY_ATTEMPTS = 5;

function subscriberId(ctx) {
  const source = ctx.sessionManager.getSessionFile() || ctx.cwd;
  return `pi_${createHash("sha256").update(source).digest("hex").slice(0, 20)}`;
}
function elapsed(startedAt) {
  const ms = Math.max(0, Date.now() - Date.parse(startedAt || new Date().toISOString()));
  return ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
}
function runLine(run) {
  const icon = run.needsAttention ? "!" : run.status === "running" ? "●" : run.ok ? "✓" : "×";
  const task = String(run.task || "").replace(/\s+/g, " ").slice(0, 60);
  const progress = run.progressText && run.progressText !== "started" ? ` · ${String(run.progressText).replace(/\s+/g, " ").slice(0, 50)}` : "";
  return `${icon} ${run.runId.slice(-8)} ${elapsed(run.startedAt)} · ${task}${progress}`;
}
function callbackMessage(run) {
  const label = run.status === "done" ? "completed" : run.status;
  return {
    customType: "terrarium-notify",
    content: `Terrarium ${label}: ${run.runId}\n${run.taskResultSummary || run.note || run.task || ""}`.trim(),
    display: true,
    details: { runId: run.runId, status: run.status, taskContractStatus: run.taskContractStatus },
  };
}

export default function terrariumPiExtension(pi) {
  // Spawned children receive no parent observer/widget. Their MCP capabilities are
  // enforced by Terrarium's lineage environment instead.
  if (process.env.TERRARIUM_RUN_ID) return;
  let timer = null;
  let currentSubscriber = null;
  let busy = false;

  async function subscribeRun(runId, ctx) {
    if (!currentSubscriber) return;
    // Cloud runs deliver terminal callbacks through the cloud Pulse mailbox, not
    // the local FS router. Register the cloud subscriber too when pulse is wired.
    if (pulseEnabled()) {
      try { await cloudPulseSubscribe(currentSubscriber, { runIds: ["*"] }); } catch { /* best effort; refresh retries */ }
    }
    const existing = await registerSubscriber({ subscriberId: currentSubscriber, runIds: [runId], channels: ["*"], workflowIds: ["*"], eventTypes: TERMINAL_TYPES, narrowWildcardRunIds: true });
    // The host observer is durable. A concrete run filter also replays a finish
    // that won the spawn/subscribe race; the normal refresh claims it.
    if (existing.replayed && ctx.hasUI) ctx.ui.notify(`Terrarium completion queued: ${runId}`, "info");
  }

  async function refresh(ctx) {
    if (busy) return;
    busy = true;
    try {
      const listing = await listRuns({ limit: 20 });
      const active = listing.runs.filter((run) => run.status === "running");
      if (ctx.hasUI) {
        const recentGroups = await listRunGroups({ limit: 8 });
        const groupStatuses = await Promise.all(recentGroups.groups.map((group) => getRunGroupStatus({ groupId: group.groupId })));
        const activeGroups = groupStatuses.filter((group) => !group.complete);
        if (active.length === 0 && activeGroups.length === 0) ctx.ui.setWidget(WIDGET, undefined);
        else {
          const lines = [ctx.ui.theme.fg("accent", `Terrarium · ${active.length} active${activeGroups.length ? ` · ${activeGroups.length} group(s)` : ""}`)];
          for (const group of activeGroups.slice(0, 3)) lines.push(ctx.ui.theme.fg("muted", `◆ ${group.label} · ${group.counts.done}/${group.runIds.length} done`));
          lines.push(...active.slice(0, 5).map((run) => ctx.ui.theme.fg(run.needsAttention ? "warning" : "dim", runLine(run))));
          ctx.ui.setWidget(WIDGET, lines);
        }
      }
      if (currentSubscriber) {
        const claimed = await claimMailboxEvents({ subscriberId: currentSubscriber, limit: 20, maxDeliveryAttempts: MAX_DELIVERY_ATTEMPTS });
        if (claimed.quarantined && ctx.hasUI) ctx.ui.notify(`Terrarium quarantined ${claimed.quarantined} undeliverable callback(s) after ${MAX_DELIVERY_ATTEMPTS} attempts`, "warning");
        for (const event of claimed.events) {
          let run; try { run = await getRunStatus({ runId: event.runId }); } catch { run = { runId: event.runId, status: event.type }; }
          // Pi supports an immediate model turn for extension messages. followUp
          // queues safely when a turn is active; triggerTurn wakes an idle session.
          // Ack only after Pi accepted the message, so a throw is replayable.
          //
          // Isolate each delivery: one throwing/poison event must not strand the
          // rest of the claimed batch inflight. On failure, requeue *only* that
          // event to pending (olderThanMs:0 forces it back regardless of claim
          // age) so the next 1.5s refresh retries it, then continue delivering the
          // surviving siblings. Without this, a single sendMessage throw aborted
          // the loop and left every later-claimed callback stuck inflight until
          // the next session_start requeue.
          try {
            pi.sendMessage(callbackMessage(run), { deliverAs: "followUp", triggerTurn: true });
            await acknowledgeMailboxEvent({ subscriberId: currentSubscriber, eventId: event.eventId });
          } catch {
            await requeueInflightEvents({ subscriberId: currentSubscriber, eventIds: [event.eventId], olderThanMs: 0 }).catch(() => {});
          }
        }
        // Cloud terminal callbacks: pull from the cloud Pulse mailbox over HTTP
        // and deliver into this session, mirroring the local path. Ack only after
        // Pi accepts the message so a throw is replayable on the next refresh.
        if (pulseEnabled()) {
          try {
            const cloud = await cloudPulseClaim(currentSubscriber, { limit: 20 });
            for (const event of cloud.events) {
              let run; try { run = await cloudStatus(event.runId); } catch { run = { runId: event.runId, status: event.status || event.type }; }
              try {
                pi.sendMessage(callbackMessage(run), { deliverAs: "followUp", triggerTurn: true });
                await cloudPulseAck(currentSubscriber, event.eventId);
              } catch { /* leave unacked; cloud redelivers on next claim */ }
            }
          } catch { /* pulse unreachable this tick; retried next refresh */ }
        }
      }
    } finally { busy = false; }
  }

  pi.on("session_start", async (_event, ctx) => {
    currentSubscriber = subscriberId(ctx);
    // Do not create a wildcard run subscription. This Pi session should only
    // wake for concrete runs it spawned; otherwise callbacks leak into sibling
    // Pi sessions that share a channel/cwd.
    //
    // A fresh session that never spawned anything has no durable subscriber
    // record yet; claim/requeue treat that as an empty mailbox no-op, so this
    // path no longer crashes before the refresh timer is armed.
    await requeueInflightEvents({ subscriberId: currentSubscriber, olderThanMs: 0 });
    await refresh(ctx);
    timer = setInterval(() => { void refresh(ctx); }, 1500);
    timer.unref?.();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!["terrarium_spawn", "terrarium_terrarium_spawn", "terrarium_spawn_batch", "terrarium_terrarium_spawn_batch"].includes(event.toolName) || event.isError) return;
    let payload;
    try {
      const text = event.content?.find?.((item) => item.type === "text")?.text;
      payload = typeof text === "string" ? JSON.parse(text) : null;
    } catch { return; }
    const runIds = new Set();
    const collect = (value) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.runId === "string" && value.runId.startsWith("ter_")) runIds.add(value.runId);
      for (const item of Object.values(value)) {
        if (Array.isArray(item)) for (const child of item) collect(child);
        else collect(item);
      }
    };
    collect(payload);
    if (!payload?.background && runIds.size === 0) return;
    for (const runId of runIds) await subscribeRun(runId, ctx);
    await refresh(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => { await refresh(ctx); });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = null;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
    // Keep the durable subscriber/mailbox across session shutdown so terminal
    // callbacks that arrive while Pi is closed can be claimed on resume.
    currentSubscriber = null;
  });

  pi.registerCommand("terrarium-status", {
    description: "Show current Terrarium runs",
    handler: async (_args, ctx) => {
      const listing = await listRuns({ limit: 10 });
      const lines = listing.runs.map(runLine);
      ctx.ui.notify(lines.length ? lines.join("\n") : "No Terrarium runs", "info");
    },
  });

  pi.registerCommand("terrarium-groups", {
    description: "Show recent Terrarium run groups",
    handler: async (_args, ctx) => {
      const listing = await listRunGroups({ limit: 10 });
      const statuses = await Promise.all(listing.groups.map((group) => getRunGroupStatus({ groupId: group.groupId })));
      const lines = statuses.map((group) => `${group.complete ? "✓" : "◆"} ${group.label} · ${group.counts.done}/${group.runIds.length} done · ${group.groupId}`);
      ctx.ui.notify(lines.length ? lines.join("\n") : "No Terrarium groups", "info");
    },
  });

  pi.registerCommand("terrarium-cancel", {
    description: "Cancel an active Terrarium run by ID",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) return ctx.ui.notify("Usage: /terrarium-cancel <runId>", "warning");
      try { const result = await cancelRun({ runId }); ctx.ui.notify(result.cancelled ? `Cancel requested: ${runId}` : result.note, result.cancelled ? "info" : "warning"); }
      catch (error) { ctx.ui.notify(error.message, "error"); }
    },
  });
}
