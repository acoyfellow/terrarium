import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR, pruneStaleChildClaims } from "../src/core.js";
import { clearInheritedTerrariumEnv } from "./helpers/terrarium-env.js";

test("pruneStaleChildClaims removes only stale claims and keeps live ones", async () => {
  clearInheritedTerrariumEnv();
  const suffix = `${process.pid}_${Date.now()}`;
  const parent = `prune-${suffix}`;
  const claimsDir = join(LOG_DIR, `${parent}.children`);
  const liveChild = `ter_live_${suffix}`;
  const missingChild = `ter_missing_${suffix}`;
  await mkdir(claimsDir, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  // A live child has a real run log; its slot claim must be preserved.
  await writeFile(join(LOG_DIR, `${liveChild}.json`), JSON.stringify({ runId: liveChild, status: "running" }));
  await Promise.all([
    writeFile(join(claimsDir, "1"), liveChild),
    writeFile(join(claimsDir, "2"), missingChild), // log absent -> stale
    writeFile(join(claimsDir, "3"), ""),            // not a run id -> stale
    writeFile(join(claimsDir, "4"), "../escape"),   // malformed -> stale
  ]);
  try {
    const result = await pruneStaleChildClaims();
    const prunedFiles = result.pruned.map((p) => p.claimFile);
    assert.ok(prunedFiles.includes(join(claimsDir, "2")));
    assert.ok(prunedFiles.includes(join(claimsDir, "3")));
    assert.ok(prunedFiles.includes(join(claimsDir, "4")));
    assert.ok(!prunedFiles.includes(join(claimsDir, "1")), "live slot must not be pruned");
    assert.equal(existsSync(join(claimsDir, "1")), true, "live claim remains");
    assert.equal(existsSync(join(claimsDir, "2")), false, "stale claim removed");
    assert.equal(existsSync(join(claimsDir, "3")), false);
    assert.equal(existsSync(join(claimsDir, "4")), false);
    assert.ok(result.count >= 3);
  } finally {
    await Promise.all([
      rm(claimsDir, { recursive: true, force: true }),
      rm(join(LOG_DIR, `${liveChild}.json`), { force: true }),
    ]);
  }
});

test("pruneStaleChildClaims garbage-collects a fully drained children directory", async () => {
  clearInheritedTerrariumEnv();
  const suffix = `${process.pid}_${Date.now()}_drain`;
  const claimsDir = join(LOG_DIR, `prune-drain-${suffix}.children`);
  await mkdir(claimsDir, { recursive: true });
  await writeFile(join(claimsDir, "1"), `ter_gone_${suffix}`);
  try {
    const result = await pruneStaleChildClaims();
    assert.ok(result.count >= 1);
    assert.equal(existsSync(claimsDir), false, "emptied children dir is removed");
  } finally {
    await rm(claimsDir, { recursive: true, force: true });
  }
});

test("pruneStaleChildClaims refuses to run as a non-top-level child", async () => {
  process.env.TERRARIUM_RUN_ID = "ter_child_actor";
  try {
    await assert.rejects(() => pruneStaleChildClaims(), /top-level controller/);
    await assert.rejects(() => pruneStaleChildClaims({ requesterRunId: "ter_child_actor" }), /top-level controller/);
  } finally {
    delete process.env.TERRARIUM_RUN_ID;
  }
});
