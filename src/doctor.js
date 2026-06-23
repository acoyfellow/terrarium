import { access, mkdir, readFile, readdir } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { CONFIG_PATH, EVENT_DIR, HOME, LOG_DIR, WORKSPACE_DIR, listRuns } from "./core.js";
import { GROUP_DIR } from "./groups.js";
import { MAILBOXES_DIR, ROUTER_DIR, SUBSCRIBERS_DIR } from "./router.js";

async function writable(path) {
  try { await mkdir(path, { recursive: true }); await access(path, constants.R_OK | constants.W_OK); return true; } catch { return false; }
}
async function count(path, filter = () => true) { try { return (await readdir(path)).filter(filter).length; } catch { return 0; } }

export async function diagnoseTerrarium() {
  const runs = await listRuns({ limit: 100 });
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
    subscribers: await count(SUBSCRIBERS_DIR, (file) => file.endsWith(".json")),
    pendingCallbacks: 0,
    inflightCallbacks: 0,
    staleChildClaims: 0,
  };
  try {
    for (const subscriber of await readdir(MAILBOXES_DIR)) {
      checks.pendingCallbacks += await count(`${MAILBOXES_DIR}/${subscriber}/pending`, (file) => file.endsWith(".json"));
      checks.inflightCallbacks += await count(`${MAILBOXES_DIR}/${subscriber}/inflight`, (file) => file.endsWith(".json"));
    }
  } catch {}
  for (const entry of await readdir(LOG_DIR)) if (entry.endsWith(".children")) {
    const dir = `${LOG_DIR}/${entry}`;
    for (const slot of await readdir(dir)) {
      let childId = ""; try { childId = (await readFile(`${dir}/${slot}`, "utf8")).trim(); } catch {}
      if (!childId || !existsSync(`${LOG_DIR}/${childId}.json`)) checks.staleChildClaims++;
    }
  }
  const warnings = [];
  if (!checks.homeWritable || !checks.logsWritable || !checks.workspaceWritable || !checks.routerWritable) warnings.push("Terrarium storage is not readable/writable");
  if (checks.orphanedRuns) warnings.push(`${checks.orphanedRuns} orphaned run(s) need inspection`);
  if (checks.needsAttentionRuns) warnings.push(`${checks.needsAttentionRuns} active run(s) need attention`);
  if (checks.pendingCallbacks) warnings.push(`${checks.pendingCallbacks} callback(s) are pending delivery`);
  if (checks.inflightCallbacks) warnings.push(`${checks.inflightCallbacks} callback(s) are claimed but unacknowledged`);
  if (checks.staleChildClaims) warnings.push(`${checks.staleChildClaims} stale child-slot claim(s) exist from older runs`);
  return { ok: warnings.length === 0, checks, warnings, paths: { home: HOME, logs: LOG_DIR, workspaces: WORKSPACE_DIR, events: EVENT_DIR, router: ROUTER_DIR } };
}
