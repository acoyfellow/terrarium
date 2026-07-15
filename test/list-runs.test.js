import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listRuns, LOG_DIR } from "../src/core.js";

const runsDir = LOG_DIR;

test("listRuns ignores background specs and reports active runs independently of page limit", async () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const activeId = `ter_test_active_${suffix}`;
  const doneId = `ter_test_done_${suffix}`;
  const paths = [
    join(runsDir, `${activeId}.json`),
    join(runsDir, `${activeId}.background.json`),
    join(runsDir, `${doneId}.json`),
  ];
  await mkdir(runsDir, { recursive: true });
  await writeFile(paths[0], JSON.stringify({ runId: activeId, status: "running", pid: process.pid, startedAt: new Date().toISOString() }));
  await writeFile(paths[1], JSON.stringify({ run: { runId: activeId }, prompt: "not metadata" }));
  await writeFile(paths[2], JSON.stringify({ runId: doneId, status: "done", ok: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
  try {
    const result = await listRuns({ limit: 1 });
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs.some((run) => !run?.runId), false);
    assert.ok(result.activeRunIds.includes(activeId));
    assert.ok(result.activeCount >= 1);
  } finally {
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }
});

test("listRuns filters by channel/workflowId/sinceMs for post-timeout recovery", async () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const now = Date.now();
  const mine = `ter_test_recov_mine_${suffix}`;
  const other = `ter_test_recov_other_${suffix}`;
  const oldOne = `ter_test_recov_old_${suffix}`;
  const paths = [
    [join(runsDir, `${mine}.json`), { runId: mine, status: "running", pid: process.pid, channel: "lane-A", workflowId: "wf-1", startedAt: new Date(now).toISOString() }],
    [join(runsDir, `${other}.json`), { runId: other, status: "running", pid: process.pid, channel: "lane-B", workflowId: "wf-2", startedAt: new Date(now).toISOString() }],
    [join(runsDir, `${oldOne}.json`), { runId: oldOne, status: "done", ok: true, exitCode: 0, channel: "lane-A", workflowId: "wf-1", startedAt: new Date(now - 3600000).toISOString(), finishedAt: new Date(now - 3600000).toISOString() }],
  ];
  await mkdir(runsDir, { recursive: true });
  await Promise.all(paths.map(([p, m]) => writeFile(p, JSON.stringify(m))));
  try {
    // Channel filter: only lane-A runs (mine + oldOne), not lane-B.
    const byChannel = await listRuns({ channel: "lane-A" });
    const ids = byChannel.runs.map((r) => r.runId);
    assert.ok(ids.includes(mine) && ids.includes(oldOne), "lane-A runs present");
    assert.ok(!ids.includes(other), "lane-B excluded");
    assert.equal(byChannel.filtered.channel, "lane-A");
    // Channel + recency: the hour-old lane-A run drops out with a 60s window.
    const recent = await listRuns({ channel: "lane-A", sinceMs: 60000 });
    const rids = recent.runs.map((r) => r.runId);
    assert.ok(rids.includes(mine) && !rids.includes(oldOne), "only the recent lane-A run");
    // Workflow filter narrows the same way.
    const byWf = await listRuns({ workflowId: "wf-2" });
    assert.deepEqual(byWf.runs.map((r) => r.runId), [other]);
  } finally {
    await Promise.all(paths.map(([p]) => rm(p, { force: true })));
  }
});

test("listRuns scan is bounded by a recent-file window (does not scale with home size)", async () => {
  const prevWindow = process.env.TERRARIUM_LIST_SCAN_WINDOW;
  const suffix = `${process.pid}_${Date.now()}`;
  const window = 50;
  process.env.TERRARIUM_LIST_SCAN_WINDOW = String(window);
  await mkdir(runsDir, { recursive: true });
  // Write far more run files than the window. Filenames embed an increasing
  // counter so sort()/reverse() yields newest-first deterministically.
  const total = window * 3;
  const made = [];
  for (let i = 0; i < total; i++) {
    const id = `ter_test_bound_${suffix}_${String(i).padStart(6, "0")}`;
    const p = join(runsDir, `${id}.json`);
    await writeFile(p, JSON.stringify({ runId: id, status: "done", ok: true, exitCode: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }));
    made.push({ id, p });
  }
  try {
    const t = Date.now();
    const result = await listRuns({ limit: 10 });
    const ms = Date.now() - t;
    // Only the bounded window was scanned, and it flags truncation.
    assert.equal(result.activeScanWindow, window);
    assert.equal(result.scanTruncated, true);
    assert.equal(result.runs.length, 10);
    // The newest files win: the returned runs are from the high end of the counter.
    const lowestReturned = result.runs.map((r) => r.runId).sort().at(0);
    const cutoff = `ter_test_bound_${suffix}_${String(total - window).padStart(6, "0")}`;
    assert.ok(lowestReturned >= cutoff, `returned runs must be from the newest window (got ${lowestReturned}, cutoff ${cutoff})`);
    // Sanity: bounded work stays quick even with 3x window files present.
    assert.ok(ms < 5000, `bounded listRuns should be fast, took ${ms}ms`);
  } finally {
    await Promise.all(made.map(({ p }) => rm(p, { force: true })));
    if (prevWindow === undefined) delete process.env.TERRARIUM_LIST_SCAN_WINDOW; else process.env.TERRARIUM_LIST_SCAN_WINDOW = prevWindow;
  }
});
