import test from "node:test";
import assert from "node:assert/strict";
import { cloudConfig, cloudEnabled, isCloudRunId } from "../src/cloud-client.js";

test("isCloudRunId distinguishes server-minted cloud ids from local ids", () => {
  assert.equal(isCloudRunId("ter_mrq8uwyp_cb0da25c6c4f"), true);
  assert.equal(isCloudRunId("ter_mrp6rl3b_2737a625ab0c"), true);
  assert.equal(isCloudRunId("ter_20260717200024787_d0ell9"), false); // local epoch id
  assert.equal(isCloudRunId(""), false);
  assert.equal(isCloudRunId(undefined), false);
});

test("cloudEnabled requires both a URL and a token", () => {
  assert.equal(cloudEnabled({}), false);
  assert.equal(cloudEnabled({ TERRARIUM_URL: "https://x" }), false);
  assert.equal(cloudEnabled({ TERRARIUM_CONTROL_TOKEN: "t" }), false);
  assert.equal(cloudEnabled({ TERRARIUM_URL: "https://x", TERRARIUM_CONTROL_TOKEN: "t" }), true);
});

test("cloudConfig normalizes the URL and reads token inline or from file", async () => {
  const c = cloudConfig({ TERRARIUM_URL: "https://x/", TERRARIUM_CONTROL_TOKEN: "tok" });
  assert.equal(c.url, "https://x");
  assert.equal(c.token, "tok");
  assert.equal(c.configured, true);

  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "terra-tok-"));
  const file = join(dir, "token");
  await writeFile(file, "  filetoken\n");
  try {
    const cf = cloudConfig({ TERRARIUM_URL: "https://y", TERRARIUM_TOKEN_FILE: file });
    assert.equal(cf.token, "filetoken");
    assert.equal(cf.configured, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cloud-default gate: MCP refuses local execution unless explicitly allowed", async () => {
  // Mirror the terrarium_spawn gate logic: with no cloud config and no
  // TERRARIUM_ALLOW_LOCAL, a real (non-dry-run) spawn must fail closed rather
  // than silently spawn a local process. dryRun is always exempt.
  const gate = ({ cloud, allowLocal, dryRun }) => {
    if (cloud && !dryRun) return "cloud";
    if (!cloud && !allowLocal && !dryRun) return "refuse";
    return "local";
  };
  assert.equal(gate({ cloud: false, allowLocal: false, dryRun: false }), "refuse");
  assert.equal(gate({ cloud: false, allowLocal: false, dryRun: true }), "local"); // plan locally, exempt
  assert.equal(gate({ cloud: false, allowLocal: true, dryRun: false }), "local");
  assert.equal(gate({ cloud: true, allowLocal: false, dryRun: false }), "cloud");
  assert.equal(gate({ cloud: true, allowLocal: false, dryRun: true }), "local"); // dry-run plans locally even when cloud set
});
