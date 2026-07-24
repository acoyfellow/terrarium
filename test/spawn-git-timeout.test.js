import test from "node:test";
import assert from "node:assert/strict";
import { spawnCapture } from "../src/core.js";

// Regression for the 2026-07-24 incident: a background/sync spawn with a cwd
// whose `git status --short` was slow (a huge working tree, or a fast git
// starved by leaked CPU-heavy processes) blocked inside prepareRun's gitInfo
// BEFORE the durable accept-receipt returned — so the MCP host's RPC deadline
// fired first: `-32001 Request timed out` with NO runId. The native CLI has no
// RPC deadline, so it "succeeded" (just waited) — the exact MCP-vs-CLI boundary.
//
// Fix: spawnCapture accepts a timeoutMs; gitInfo bounds its git calls so a slow
// git returns null metadata (advisory) instead of blocking the accept-receipt.

test("spawnCapture kills a subprocess that exceeds timeoutMs and returns a timed-out marker", async () => {
  const t0 = Date.now();
  // `sleep 10` stands in for a slow `git status` on a huge/starved tree.
  const r = await spawnCapture("sleep", ["10"], { timeoutMs: 300 });
  const elapsed = Date.now() - t0;
  assert.equal(r.timedOut, true, "must report timedOut");
  assert.equal(r.code, 124, "timed-out code");
  assert.ok(elapsed < 3000, `must return promptly after the timeout, got ${elapsed}ms`);
});

test("spawnCapture without timeoutMs still runs to completion (unchanged behavior)", async () => {
  const r = await spawnCapture("printf", ["ok"], {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "ok");
  assert.notEqual(r.timedOut, true);
});

test("a fast subprocess under a generous timeout completes normally (not killed)", async () => {
  const r = await spawnCapture("printf", ["fast"], { timeoutMs: 5000 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "fast");
  assert.notEqual(r.timedOut, true);
});
