import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { TerrariumRunCell } from "../src/cloud/local-run-cell.js";
import { cloudboxRunToReceipt } from "../scripts/drift-lab/cloudbox-adapter.mjs";

const ROOT = "/workspace";

async function loadFixture(name) {
  return JSON.parse(await readFile(new URL(`./fixtures/cloudbox-adapter/${name}`, import.meta.url), "utf8"));
}

function makeReceipt({ runId, taskFingerprint, nonce, summary = "cloudbox task completed" }) {
  return { runId, taskFingerprint, nonce, summary };
}

test("Cloudbox bridge keeps TERRARIUM_RESULT as authority and attaches advisory drift receipt", async () => {
  const cell = new TerrariumRunCell();
  const { runId, contract } = cell.launch({ task: "cloudbox-backed docs update", ownerId: "owner-A" });
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "done");
  assert.equal(terminal.taskContractStatus, "verified");

  const result = await loadFixture("run-drift.json");
  const envelope = await loadFixture("envelope.json");
  const driftReceipt = cloudboxRunToReceipt({ result, envelope, root: ROOT, runId });

  assert.equal(driftReceipt.schema, "terrarium-drift-lab-receipt-v0");
  assert.equal(driftReceipt.source, "cloudbox");
  assert.equal(driftReceipt.runId, runId);
  assert.equal(driftReceipt.driftScore, 0.2);
  assert.ok(driftReceipt.violations.length > 0);
  // v0 semantics: capability drift is advisory and does not rewrite the task-contract terminal.
  assert.equal(terminal.status, "done");
  assert.equal(terminal.ok, true);
});

test("Cloudbox ok:true without a matching TERRARIUM_RESULT is inconclusive", async () => {
  const cell = new TerrariumRunCell();
  const { runId } = cell.launch({
    task: "cloudbox ok is not enough",
    ownerId: "owner-A",
    spec: { exitCode: 0, emitReceipt: false },
  });
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "inconclusive");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.taskContractStatus, "missing");
});

test("Cloudbox ok:true with mismatched TERRARIUM_RESULT is inconclusive", async () => {
  const cell = new TerrariumRunCell();
  const { runId } = cell.launch({
    task: "cloudbox mismatched receipt",
    ownerId: "owner-A",
    spec: { exitCode: 0, receiptOverride: { nonce: "wrong" } },
  });
  const terminal = await cell.collect(runId);
  assert.equal(terminal.status, "inconclusive");
  assert.equal(terminal.ok, false);
  assert.equal(terminal.taskContractStatus, "mismatch");
});

test("Cloudbox bridge terminal callback remains single and owner-scoped", async () => {
  const cell = new TerrariumRunCell();
  const { runId } = cell.launch({ task: "terminal callback after bridge", ownerId: "owner-A" });
  cell.subscribe("owner-sub", { runId, ownerId: "owner-A" });
  cell.subscribe("other-sub", { runId, ownerId: "owner-B" });
  await Promise.all([cell.collect(runId), cell.collect(runId)]);

  const ownerCallbacks = cell.collectCallbacks("owner-sub");
  const otherCallbacks = cell.collectCallbacks("other-sub");
  assert.equal(ownerCallbacks.length, 1);
  assert.equal(ownerCallbacks[0].eventId, `evt_${runId}_terminal`);
  assert.equal(otherCallbacks.length, 0);
});
