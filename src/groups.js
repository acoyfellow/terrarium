import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HOME, assertRunId, getRunStatus, readRun } from "./core.js";

export const GROUP_DIR = join(HOME, "groups");

function assertGroupId(groupId) {
  if (typeof groupId !== "string" || !/^grp_[A-Za-z0-9_]+$/.test(groupId)) throw new Error("invalid Terrarium group id");
  return groupId;
}

export async function createRunGroup({ label = "Terrarium group", runIds, groupId = `grp_${randomUUID().replaceAll("-", "_")}` } = {}) {
  assertGroupId(groupId);
  if (!Array.isArray(runIds) || runIds.length < 1 || runIds.length > 32) throw new Error("group requires 1-32 run IDs");
  const unique = [...new Set(runIds.map(assertRunId))];
  if (unique.length !== runIds.length) throw new Error("group run IDs must be unique");
  for (const runId of unique) await getRunStatus({ runId });
  const group = { version: 1, groupId, label: String(label).slice(0, 120), runIds: unique, createdAt: new Date().toISOString() };
  await mkdir(GROUP_DIR, { recursive: true });
  await writeFile(join(GROUP_DIR, `${groupId}.json`), JSON.stringify(group, null, 2) + "\n", { flag: "wx" });
  return group;
}

export async function getRunGroup(groupId) {
  assertGroupId(groupId);
  return JSON.parse(await readFile(join(GROUP_DIR, `${groupId}.json`), "utf8"));
}

export async function getRunGroupStatus({ groupId, verbose = false } = {}) {
  const group = await getRunGroup(groupId);
  const runs = await Promise.all(group.runIds.map(async (runId) => {
    try { return await getRunStatus({ runId }); }
    catch (error) { return { runId, status: "missing", ok: false, error: error.message }; }
  }));
  const counts = Object.fromEntries(["running", "done", "failed", "inconclusive", "cancelled", "error", "orphaned", "missing"].map((status) => [status, runs.filter((run) => run.status === status).length]));
  const complete = runs.every((run) => !["running"].includes(run.status));
  return { ...group, complete, counts, runs: verbose ? runs : runs.map(({ runId, status, ok, exitCode, taskContractStatus, progressText, needsAttention, idleMs, startedAt, finishedAt, error, note }) => ({ runId, status, ok, exitCode, taskContractStatus, progressText, needsAttention, idleMs, startedAt, finishedAt, error, note })) };
}

export async function readRunGroupLogs({ groupId, kind = "terrarium", tailBytes = 2000 } = {}) {
  const group = await getRunGroup(groupId);
  const results = await Promise.all(group.runIds.map(async (runId) => {
    try { const value = await readRun({ runId, kind, tailBytes }); return { runId, text: value.text }; }
    catch (error) { return { runId, error: error.message }; }
  }));
  return { groupId, kind, results };
}
