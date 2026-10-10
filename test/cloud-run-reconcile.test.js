import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { LOG_DIR, getRunStatus, recordCloudAdmission, recordCloudTerminal } from "../src/core.js";

test("a cloud run admitted locally is never orphaned by local process reconciliation", async () => {
  const runId = `ter_cloudrec${Date.now().toString(36)}_abcdef`;
  await recordCloudAdmission({ runId, task: "cloud task", background: true });
  const status = await getRunStatus({ runId, staleMs: 0 });
  assert.equal(status.status, "running");
});

test("recordCloudTerminal settles a running cloud admission with the server verdict", async () => {
  const runId = `ter_cloudfin${Date.now().toString(36)}_abcdef`;
  await recordCloudAdmission({ runId, task: "cloud task" });
  await recordCloudTerminal({ runId, cloud: true, ok: true, status: "done", exitCode: 0, taskContractStatus: "verified", taskResultSummary: "hello" });
  const status = await getRunStatus({ runId, staleMs: 0 });
  assert.equal(status.status, "done");
  assert.equal(status.taskContractStatus, "verified");
  assert.equal(status.taskContract, undefined);
});

test("recordCloudTerminal never overwrites an already terminal record", async () => {
  const runId = `ter_cloudkeep${Date.now().toString(36)}_abcdef`;
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(`${LOG_DIR}/${runId}.json`, JSON.stringify({ runId, cloud: true, status: "cancelled", ok: false }));
  await recordCloudTerminal({ runId, cloud: true, ok: true, status: "done" });
  const status = await getRunStatus({ runId, staleMs: 0 });
  assert.equal(status.status, "cancelled");
});
