import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { metadataPath, recordCloudAdmission } from "../src/core.js";

function runId(suffix) {
  return `ter_accept_${Date.now().toString(36)}_${suffix}`;
}

test("a cloud admission is persisted before any polling, so a timed-out RPC keeps the run ID", async () => {
  const id = runId("basic");
  const result = await recordCloudAdmission({
    runId: id,
    channel: "cloudflare",
    task: "bounded read-only dig",
    model: "gpt-5.6-terra",
    contract: { taskFingerprint: "fp-abc", nonce: "n-1" },
    executionRef: "exec-1",
  });
  assert.equal(result.persisted, true);
  assert.ok(existsSync(metadataPath(id)));
  const meta = JSON.parse(readFileSync(metadataPath(id), "utf8"));
  assert.equal(meta.runId, id);
  assert.equal(meta.cloud, true);
  assert.equal(meta.status, "running");
  assert.equal(meta.channel, "cloudflare");
  assert.equal(meta.progressText, "admitted");
  assert.equal(meta.taskContractStatus, "pending");
  assert.equal(meta.taskFingerprint, "fp-abc");
});

test("recording the same admission twice does not clobber the first record", async () => {
  const id = runId("idem");
  const first = await recordCloudAdmission({ runId: id, task: "one" });
  const second = await recordCloudAdmission({ runId: id, task: "two" });
  assert.equal(first.persisted, true);
  assert.equal(second.persisted, false);
  assert.equal(JSON.parse(readFileSync(metadataPath(id), "utf8")).task, "one");
});

test("an admission without a contract still derives a task fingerprint", async () => {
  const id = runId("fp");
  await recordCloudAdmission({ runId: id, task: "derive my fingerprint" });
  const meta = JSON.parse(readFileSync(metadataPath(id), "utf8"));
  assert.equal(typeof meta.taskFingerprint, "string");
  assert.ok(meta.taskFingerprint.length > 0);
});

test("an invalid run id is rejected rather than writing a stray file", async () => {
  await assert.rejects(() => recordCloudAdmission({ runId: "not-a-terrarium-id" }), /invalid Terrarium run id/);
});
