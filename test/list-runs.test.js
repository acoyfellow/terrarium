import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { listRuns } from "../src/core.js";

const runsDir = join(homedir(), ".terrarium", "runs");

test("listRuns ignores background specs and reports active runs independently of page limit", async () => {
  const suffix = `${process.pid}-${Date.now()}`;
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
