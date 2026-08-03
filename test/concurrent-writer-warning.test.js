import test from "node:test";
import assert from "node:assert/strict";
import { findUnisolatedCoWriters } from "../src/core.js";

const liveWriter = (runId, cwd = "/w") => ({ runId, status: "running", alive: true, isolation: "none", cwd });

test("a live unisolated run sharing the cwd is reported as a co-writer", () => {
  assert.deepEqual(findUnisolatedCoWriters({ runs: [liveWriter("ter_a")], cwd: "/w" }), ["ter_a"]);
});

test("an isolated run is not a co-writer, because it does not share the tree", () => {
  const runs = [{ ...liveWriter("ter_a"), isolation: "copy" }, { ...liveWriter("ter_b"), isolation: "worktree" }];
  assert.deepEqual(findUnisolatedCoWriters({ runs, cwd: "/w" }), []);
});

test("finished and dead runs are not co-writers", () => {
  const runs = [
    { ...liveWriter("ter_done"), status: "done", alive: false },
    { ...liveWriter("ter_dead"), alive: false },
  ];
  assert.deepEqual(findUnisolatedCoWriters({ runs, cwd: "/w" }), []);
});

test("a run in a different cwd is not a co-writer", () => {
  assert.deepEqual(findUnisolatedCoWriters({ runs: [liveWriter("ter_a", "/other")], cwd: "/w" }), []);
});

test("read-only runs neither collide nor are collided with", () => {
  const reader = { ...liveWriter("ter_reader"), readOnly: true };
  assert.deepEqual(findUnisolatedCoWriters({ runs: [reader], cwd: "/w" }), []);
  assert.deepEqual(findUnisolatedCoWriters({ runs: [liveWriter("ter_a")], cwd: "/w", readOnly: true }), []);
});

test("an isolated or read-only spawn is never warned about its neighbours", () => {
  const runs = [liveWriter("ter_a"), liveWriter("ter_b")];
  assert.deepEqual(findUnisolatedCoWriters({ runs, cwd: "/w", isolation: "copy" }), []);
  assert.deepEqual(findUnisolatedCoWriters({ runs, cwd: "/w", isolation: "worktree" }), []);
});

test("the reported 2026-08-02 collision is detected while distinct fingerprints are not", () => {
  const runs = [
    { runId: "ter_20260802165322837_mc77xg", status: "running", alive: true, isolation: "none", cwd: "/Users/jcoeyman/cloudflare", taskFingerprint: "fed5e24ccece81a0986193e1" },
  ];
  const collisions = findUnisolatedCoWriters({
    runs,
    cwd: "/Users/jcoeyman/cloudflare",
    isolation: "none",
  });
  assert.deepEqual(collisions, ["ter_20260802165322837_mc77xg"]);
});

test("runs missing an isolation field default to unisolated rather than being ignored", () => {
  const runs = [{ runId: "ter_legacy", status: "running", alive: true, cwd: "/w" }];
  assert.deepEqual(findUnisolatedCoWriters({ runs, cwd: "/w" }), ["ter_legacy"]);
});

test("originalCwd is honoured when cwd is absent", () => {
  const runs = [{ runId: "ter_orig", status: "running", alive: true, isolation: "none", originalCwd: "/w" }];
  assert.deepEqual(findUnisolatedCoWriters({ runs, cwd: "/w" }), ["ter_orig"]);
});
