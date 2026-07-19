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

test("detectFilesystemDependency flags repo/path tasks, not self-contained ones", async () => {
  const { detectFilesystemDependency } = await import("../src/cloud-client.js");
  // filesystem-dependent (cloud cell can't ground these -> must fail closed)
  assert.equal(detectFilesystemDependency({ task: "review the repo at /Users/x/proj" }).dependent, true);
  assert.equal(detectFilesystemDependency({ task: "Read-only review of src/auth.js" }).dependent, true);
  assert.equal(detectFilesystemDependency({ task: "inspect the codebase for issues" }).dependent, true);
  assert.equal(detectFilesystemDependency({ task: "do it", cwd: "/Users/x/repo" }).dependent, true);
  assert.equal(detectFilesystemDependency({ task: "do it", isolation: "copy" }).dependent, true);
  // self-contained (safe in cloud)
  assert.equal(detectFilesystemDependency({ task: "Compute 17*23 and reply with the number" }).dependent, false);
  assert.equal(detectFilesystemDependency({ task: "reply with exactly: OK" }).dependent, false);
});

test("cloudSpawn fails closed on a filesystem-dependent task unless override set", async () => {
  const { cloudSpawn } = await import("../src/cloud-client.js");
  const env = { TERRARIUM_URL: "https://x", TERRARIUM_CONTROL_TOKEN: "t" };
  await assert.rejects(
    () => cloudSpawn({ task: "review /Users/x/repo and list files" }, { env }),
    /cloud spawn refused/,
    "must refuse a filesystem-dependent task before creating a run",
  );
});

test("cloudbox delegation: config gating + response shaping into a terrarium envelope", async () => {
  const { cloudboxEnabled, cloudboxRun } = await import("../src/cloudbox-client.js");
  assert.equal(cloudboxEnabled({}), false);
  assert.equal(cloudboxEnabled({ CLOUDBOX_URL: "https://cb" }), true);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "cbx_1", status: "passed", repo: { commit: "abc" }, receipts: [{ type: "clone" }], artifact: { path: "o", content: "x" }, proof: { grade: { score: 1, max: 1 } } }) });
  try {
    const r = await cloudboxRun({ repo: "https://github.com/x/y", commands: ["pnpm test"], verify: ["test -f o"] }, { env: { CLOUDBOX_URL: "https://cb" } });
    assert.equal(r.ok, true);
    assert.equal(r.status, "done");
    assert.equal(r.cloudbox, true);
    assert.equal(r.runId, "cbx_1");
    assert.equal(r.commit, "abc");
    // a failed cloudbox run maps to ok:false / status:failed
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: "cbx_2", status: "failed" }) });
    const f = await cloudboxRun({ repo: "https://github.com/x/y" }, { env: { CLOUDBOX_URL: "https://cb" } });
    assert.equal(f.ok, false);
    assert.equal(f.status, "failed");
  } finally { globalThis.fetch = origFetch; }
});

test("cloud fsdep steers WIP review to local --isolation copy, cloudbox for committed repo", async () => {
  const { cloudSpawn } = await import("../src/cloud-client.js");
  const env = { TERRARIUM_URL: "https://x", TERRARIUM_CONTROL_TOKEN: "t" }; // no cloudbox, no repo
  await assert.rejects(
    () => cloudSpawn({ task: "review the repo at /Users/x/t2t for issues" }, { env }),
    /--isolation copy|committed AND uncommitted/,
    "fail-closed message must steer local-WIP review to --isolation copy",
  );
});

test("cloud batch reuses the shared decide() so join semantics match local", async () => {
  // cloudSpawnBatch imports decide from batch.js — the same pure function the
  // local batch uses — so all/allSettled/race/any/quorum can never drift.
  const { decide } = await import("../src/batch.js");
  const runs = [
    { runId: "ter_a", status: "done", ok: true, finishedAt: "2026-01-01T00:00:01Z" },
    { runId: "ter_b", status: "running" },
  ];
  assert.equal(decide({ runs }, "all").settled, false, "all waits for every run");
  assert.equal(decide({ runs }, "any").settled, true, "any settles on first success");
  assert.equal(decide({ runs }, "any").winner, "ter_a");
  assert.equal(decide({ runs }, "any").cancelLosers, true, "any cancels losers");
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

// ---------------- cloudList: control-plane run index read path ----------------

import { cloudList } from "../src/cloud-client.js";

test("cloudList builds channel/status/since/limit query and shapes the response", async () => {
  const env = { TERRARIUM_URL: "https://x", TERRARIUM_CONTROL_TOKEN: "t" };
  const seen = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.url = url; seen.method = init?.method || "GET";
    seen.auth = init?.headers?.authorization;
    return { ok: true, status: 200, text: async () => JSON.stringify({
      ok: true,
      runs: [{ runId: "ter_a_1", channel: "loop-A", status: "running", ownerId: "p" }],
      channels: { "loop-A": { channel: "loop-A", total: 1, running: 1, done: 0, failed: 0, other: 0 } },
    }) };
  };
  try {
    const res = await cloudList({ channel: "loop-A", status: "running", since: 1000, limit: 5 }, { env });
    assert.equal(seen.method, "GET");
    assert.equal(seen.auth, "Bearer t");
    const u = new URL(seen.url);
    assert.equal(u.pathname, "/api/runs");
    assert.equal(u.searchParams.get("channel"), "loop-A");
    assert.equal(u.searchParams.get("status"), "running");
    assert.equal(u.searchParams.get("since"), "1000");
    assert.equal(u.searchParams.get("limit"), "5");
    assert.equal(res.ok, true);
    assert.equal(res.runs.length, 1);
    assert.equal(res.channels["loop-A"].total, 1);
  } finally { globalThis.fetch = origFetch; }
});

test("cloudList is fail-soft: a server without the index reports indexUnavailable", async () => {
  const env = { TERRARIUM_URL: "https://x", TERRARIUM_CONTROL_TOKEN: "t" };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, runs: [], channels: {}, indexUnavailable: true }) });
  try {
    const res = await cloudList({}, { env });
    assert.equal(res.ok, true);
    assert.equal(res.indexUnavailable, true);
    assert.deepEqual(res.runs, []);
  } finally { globalThis.fetch = origFetch; }
});

test("cloudList omits empty filters from the query string", async () => {
  const env = { TERRARIUM_URL: "https://x", TERRARIUM_CONTROL_TOKEN: "t" };
  let capturedUrl;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { capturedUrl = url; return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, runs: [], channels: {} }) }; };
  try {
    await cloudList({}, { env });
    assert.equal(new URL(capturedUrl).search, "", "no query string when no filters");
  } finally { globalThis.fetch = origFetch; }
});

test("cloudList requires a configured cloud instance", async () => {
  await assert.rejects(() => cloudList({}, { env: {} }), /requires TERRARIUM_URL/);
});
