import test from "node:test";
import assert from "node:assert/strict";
import {
  contractLabel,
  formatRunLine,
  formatRunList,
  formatRunStatus,
  livenessGlyph,
} from "../src/status-format.js";

test("livenessGlyph separates live, stale-running, terminal, and error states", () => {
  assert.equal(livenessGlyph({ status: "running", alive: true }), "*");
  assert.equal(livenessGlyph({ status: "running", alive: false }), "~");
  assert.equal(livenessGlyph({ status: "done", ok: true }), "+");
  assert.equal(livenessGlyph({ status: "done", ok: false }), "x");
  assert.equal(livenessGlyph({ status: "cancelled" }), "/");
  assert.equal(livenessGlyph({ status: "orphaned" }), "!");
  assert.equal(livenessGlyph({ status: "failed" }), "x");
  assert.equal(livenessGlyph({ status: "inconclusive" }), "?");
  assert.equal(livenessGlyph(null), "?");
});

test("contractLabel never invents 'verified' from a missing or terminated contract", () => {
  assert.equal(contractLabel({ taskContractStatus: "verified" }), "verified");
  assert.equal(contractLabel({ taskContractStatus: "not-applicable" }), "n/a");
  assert.equal(contractLabel({ taskContractStatus: "violated" }), "violated");
  assert.equal(contractLabel({}), "-");
  assert.equal(contractLabel(null), "-");
});

test("a cancelled run with a leaked-looking record never reads as a task win", () => {
  // Honesty regression: liveness and contract are independent columns. Even a
  // cancelled run is shown as cancelled, contract as whatever it actually is.
  const cancelled = { runId: "ter_x", status: "cancelled", ok: false, taskContractStatus: "not-applicable", task: "do the thing" };
  const line = formatRunLine(cancelled);
  assert.match(line, /^\/ /); // cancelled glyph
  assert.match(line, /cancelled/);
  assert.match(line, /n\/a/);
  assert.doesNotMatch(line, /verified/);
});

test("formatRunLine clips long tasks with an ellipsis and is single-line", () => {
  const run = { runId: "ter_long", status: "done", ok: true, task: "x".repeat(200) };
  const line = formatRunLine(run, { taskWidth: 20 });
  assert.equal(line.includes("\n"), false);
  assert.ok(line.includes("\u2026"));
  assert.ok(line.length < 120);
});

test("formatRunList renders header, legend, honesty note, and one line per run", () => {
  const result = {
    version: "9.9.9",
    logDir: "/tmp/runs",
    activeCount: 1,
    activeRunIds: ["ter_a"],
    count: 2,
    runs: [
      { runId: "ter_a", status: "running", alive: true, task: "alpha" },
      { runId: "ter_b", status: "done", ok: true, taskContractStatus: "verified", task: "beta" },
    ],
  };
  const out = formatRunList(result);
  assert.match(out, /active 1/);
  assert.match(out, /shown 2/);
  assert.match(out, /\/tmp\/runs/);
  assert.match(out, /ter_a/);
  assert.match(out, /ter_b/);
  assert.match(out, /legend:/);
  assert.match(out, /'status' is liveness; 'contract' is task truth/);
  // one line per run between header and trailing legend block
  assert.equal(out.split("\n").filter((l) => l.startsWith("* ") || l.startsWith("+ ")).length, 2);
});

test("formatRunList handles an empty run set without throwing", () => {
  const out = formatRunList({ version: "1", activeCount: 0, count: 0, runs: [] });
  assert.match(out, /no visible runs/);
});

test("formatRunStatus appends timing/exit/attention detail to the shared line", () => {
  const run = {
    runId: "ter_s",
    status: "failed",
    ok: false,
    exitCode: 2,
    taskContractStatus: "not-applicable",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:05Z",
    needsAttention: true,
    reason: "deadline-reached",
    task: "boom",
  };
  const out = formatRunStatus(run);
  assert.match(out, /^x /); // failed glyph reuses formatRunLine
  assert.match(out, /exit 2/);
  assert.match(out, /started 2026-01-01T00:00:00Z/);
  assert.match(out, /NEEDS-ATTENTION/);
  assert.match(out, /reason: deadline-reached/);
  assert.doesNotMatch(out, /verified/);
});
