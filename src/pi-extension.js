import { createHash } from "node:crypto";
import { cancelRun, getRunStatus, listRuns } from "./core.js";
import { getRunGroupStatus, listRunGroups } from "./groups.js";
import { acknowledgeMailboxEvent, claimMailboxEvents, registerSubscriber, unregisterSubscriber } from "./router.js";

const WIDGET = "terrarium-runs";

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

export default function terrariumPiExtension(pi) {
  // Spawned children receive no parent observer/widget. Their MCP capabilities are
  // enforced by Terrarium's lineage environment instead.
  if (process.env.TERRARIUM_RUN_ID) return;
  let timer = null;
  let currentSubscriber = null;
  let busy = false;

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
        const claimed = await claimMailboxEvents({ subscriberId: currentSubscriber, limit: 20 });
        for (const event of claimed.events) {
          let run; try { run = await getRunStatus({ runId: event.runId }); } catch { run = { runId: event.runId, status: event.type }; }
          const label = run.status === "done" ? "completed" : run.status;
          pi.sendMessage({ customType: "terrarium-notify", content: `Terrarium ${label}: ${run.runId}\n${run.taskResultSummary || run.note || run.task || ""}`.trim(), display: true, details: { runId: run.runId, status: run.status, taskContractStatus: run.taskContractStatus } }, { deliverAs: "followUp", triggerTurn: false });
          await acknowledgeMailboxEvent({ subscriberId: currentSubscriber, eventId: event.eventId });
        }
      }
    } finally { busy = false; }
  }

  pi.on("session_start", async (_event, ctx) => {
    currentSubscriber = subscriberId(ctx);
    await registerSubscriber({ subscriberId: currentSubscriber, runIds: ["*"], channels: ["*"], workflowIds: ["*"], eventTypes: ["Completed", "Failed", "TimedOut", "Cancelled"] });
    await refresh(ctx);
    timer = setInterval(() => { void refresh(ctx); }, 1500);
    timer.unref?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = null;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
    if (currentSubscriber) await unregisterSubscriber(currentSubscriber);
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
