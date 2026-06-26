import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { conciseBatch, conciseListing, conciseSpawn, conciseStatus } from "../src/mcp.js";

const MCP_PATH = fileURLToPath(new URL("../src/mcp.js", import.meta.url));

function jsonBytes(o) { return Buffer.byteLength(JSON.stringify(o), "utf8"); }

test("conciseSpawn drops envelope and keeps failure-triage fields", () => {
  const full = {
    ok: false,
    runId: "ter_test_1",
    parentRunId: "ter_parent",
    depth: 2,
    maxDepth: 3,
    version: "0.0.1",
    agent: "opencode run",
    model: "anthropic/claude-sonnet-4-6",
    task: "echo a task that is much longer than we want repeated to the parent",
    cwd: "/path/to/working/dir",
    originalCwd: "/path/to/working/dir",
    isolation: "none",
    workspace: null,
    logPath: "/Users/x/.terrarium/runs/ter_test_1.log",
    mreLogPath: "/Users/x/.terrarium/runs/ter_test_1.mre.log",
    git: { root: "/repo", head: "abc123", status: "?? something" },
    startedAt: "2026-05-19T19:00:00.000Z",
    finishedAt: "2026-05-19T19:00:01.000Z",
    status: "failed",
    background: false,
    exitCode: 17,
    signal: null,
    error: "child died",
    note: "supervisor saw EIO",
    taskContractStatus: "mismatch",
    failureKind: "runner-busy",
    retryable: true,
    stdoutTail: "out",
    stderrTail: "err",
  };
  const projected = conciseSpawn(full);
  assert.equal(projected.ok, false);
  assert.equal(projected.runId, "ter_test_1");
  assert.equal(projected.status, "failed");
  assert.equal(projected.model, "anthropic/claude-sonnet-4-6");
  assert.equal(projected.exitCode, 17);
  assert.equal(projected.error, "child died");
  assert.equal(projected.note, "supervisor saw EIO");
  assert.equal(projected.taskContractStatus, "mismatch");
  assert.equal(projected.failureKind, "runner-busy");
  assert.equal(projected.retryable, true);
  assert.equal(projected.startedAt, "2026-05-19T19:00:00.000Z");
  assert.equal(projected.finishedAt, "2026-05-19T19:00:01.000Z");
  assert.equal(projected.tail, "out");
  assert.equal(projected.errTail, "err");
  assert.equal(projected.task, undefined);
  assert.equal(projected.cwd, undefined);
  assert.equal(projected.originalCwd, undefined);
  assert.equal(projected.agent, undefined);
  assert.equal(projected.git, undefined);
  assert.equal(projected.workspace, undefined);
  assert.equal(projected.logPath, undefined);
  assert.equal(projected.mreLogPath, undefined);
  assert.equal(projected.depth, undefined);
  assert.equal(projected.maxDepth, undefined);
  assert.equal(projected.parentRunId, undefined);
  assert.equal(projected.version, undefined);
  assert.ok(jsonBytes(projected) < jsonBytes(full));
});

test("conciseSpawn caps tail and marks truncation", () => {
  const big = "x".repeat(8000);
  const projected = conciseSpawn({ ok: true, runId: "r", status: "done", exitCode: 0, stdoutTail: big });
  assert.equal(projected.tail.length, 2000);
  assert.equal(projected.tailTruncated, true);
});

test("conciseSpawn preserves background flag and omits when false/undefined", () => {
  assert.equal(conciseSpawn({ ok: true, runId: "r", status: "done", background: true }).background, true);
  assert.equal(conciseSpawn({ ok: true, runId: "r", status: "done", background: false }).background, undefined);
  assert.equal(conciseSpawn({ ok: true, runId: "r", status: "done" }).background, undefined);
});

test("conciseStatus keeps alive/exitCode/signal/note for triage and drops noise", () => {
  const full = {
    runId: "ter_test_2",
    parentRunId: "ter_parent",
    depth: 1,
    maxDepth: 3,
    version: "0.0.1",
    agent: "opencode run",
    model: "anthropic/claude-sonnet-4-6",
    task: "do the thing",
    cwd: "/path",
    originalCwd: "/path",
    isolation: "none",
    workspace: null,
    logPath: "/Users/x/.terrarium/runs/ter_test_2.log",
    mreLogPath: "/Users/x/.terrarium/runs/ter_test_2.mre.log",
    git: { root: "/repo", head: "abc123" },
    startedAt: "2026-05-19T19:00:00.000Z",
    status: "running",
    background: true,
    pid: 1234,
    childPid: 1234,
    supervisorPid: 5678,
    alive: true,
    logAgeMs: 1200,
    stdoutTail: "should not appear in concise status",
    stderrTail: "should not appear in concise status",
  };
  const projected = conciseStatus(full);
  assert.equal(projected.runId, "ter_test_2");
  assert.equal(projected.status, "running");
  assert.equal(projected.model, "anthropic/claude-sonnet-4-6");
  assert.equal(projected.background, true);
  assert.equal(projected.alive, true);
  assert.equal(projected.logAgeMs, 1200);
  assert.equal(projected.startedAt, "2026-05-19T19:00:00.000Z");
  assert.equal(projected.task, undefined);
  assert.equal(projected.cwd, undefined);
  assert.equal(projected.agent, undefined);
  assert.equal(projected.git, undefined);
  assert.equal(projected.logPath, undefined);
  assert.equal(projected.mreLogPath, undefined);
  assert.equal(projected.pid, undefined);
  assert.equal(projected.supervisorPid, undefined);
  assert.equal(projected.stdoutTail, undefined);
  assert.equal(projected.stderrTail, undefined);
});

test("conciseStatus surfaces runner failure classification", () => {
  const projected = conciseStatus({
    runId: "ter_test_busy",
    status: "failed",
    ok: false,
    failureKind: "runner-busy",
    retryable: true,
  });
  assert.equal(projected.failureKind, "runner-busy");
  assert.equal(projected.retryable, true);
});

test("conciseStatus surfaces orphaned diagnostics", () => {
  const full = {
    runId: "ter_test_orphan",
    status: "orphaned",
    ok: false,
    note: "No live Terrarium child process found and log is stale.",
    orphanedAt: "2026-05-19T19:01:00.000Z",
    finishedAt: "2026-05-19T19:01:00.000Z",
  };
  const projected = conciseStatus(full);
  assert.equal(projected.status, "orphaned");
  assert.equal(projected.ok, false);
  assert.match(projected.note, /No live Terrarium child/);
  assert.equal(projected.orphanedAt, "2026-05-19T19:01:00.000Z");
});

test("conciseListing returns count + per-run triage with task truncated", () => {
  const longTask = "task ".repeat(40);
  const full = {
    version: "0.0.1",
    logDir: "/Users/x/.terrarium/runs",
    activeCount: 1,
    activeRunIds: ["d"],
    runs: [
      { runId: "a", status: "done", model: "test-model", ok: true, exitCode: 0, task: "short", startedAt: "t1", finishedAt: "t2" },
      { runId: "b", status: "failed", ok: false, exitCode: 1, error: "boom", failureKind: "runner-busy", retryable: true, task: longTask, startedAt: "t3", finishedAt: "t4" },
      { runId: "c", status: "orphaned", background: true, alive: false, logAgeMs: 1234, orphanedAt: "t6", task: "ongoing", startedAt: "t5" },
    ],
  };
  const projected = conciseListing(full);
  assert.equal(projected.count, 3);
  assert.equal(projected.activeCount, 1);
  assert.deepEqual(projected.activeRunIds, ["d"]);
  assert.equal(projected.runs.length, 3);
  assert.equal(projected.runs[0].task, "short");
  assert.equal(projected.runs[0].model, "test-model");
  assert.ok(projected.runs[1].task.endsWith("..."));
  assert.ok(projected.runs[1].task.length <= 80);
  assert.equal(projected.runs[1].error, "boom");
  assert.equal(projected.runs[1].exitCode, 1);
  assert.equal(projected.runs[1].failureKind, "runner-busy");
  assert.equal(projected.runs[1].retryable, true);
  assert.equal(projected.runs[2].alive, false);
  assert.equal(projected.runs[2].background, true);
  assert.equal(projected.runs[2].logAgeMs, 1234);
  assert.equal(projected.runs[2].orphanedAt, "t6");
  assert.equal(projected.version, undefined);
  assert.equal(projected.logDir, undefined);
});

test("conciseBatch preserves partial-launch, cleanup, and group correlation diagnostics", () => {
  const projected = conciseBatch({
    ok: false,
    apiVersion: "terrarium-batch-test",
    schemaVersion: "terrarium-batch-schema-test",
    supportedOptions: ["cleanupTimeoutMs"],
    strategy: "allSettled",
    groupId: "grp_partial",
    runIds: ["ter_started"],
    reason: "launch-failed",
    launchError: "Pi wrapper rejected cancellation",
    launchErrors: ["Pi wrapper rejected cancellation", "child budget exceeded"],
    launchedCount: 1,
    unlaunchedCount: 2,
    cleanupErrors: ["ter_started: cancellation settlement failed"],
    group: {
      groupId: "grp_partial",
      counts: { cancelled: 1 },
      complete: true,
      runs: [{ runId: "ter_started", status: "cancelled", ok: false }],
    },
  });

  assert.equal(projected.apiVersion, "terrarium-batch-test");
  assert.equal(projected.schemaVersion, "terrarium-batch-schema-test");
  assert.deepEqual(projected.supportedOptions, ["cleanupTimeoutMs"]);
  assert.equal(projected.groupId, "grp_partial");
  assert.deepEqual(projected.runIds, ["ter_started"]);
  assert.equal(projected.launchError, "Pi wrapper rejected cancellation");
  assert.deepEqual(projected.launchErrors, ["Pi wrapper rejected cancellation", "child budget exceeded"]);
  assert.equal(projected.launchedCount, 1);
  assert.equal(projected.unlaunchedCount, 2);
  assert.deepEqual(projected.cleanupErrors, ["ter_started: cancellation settlement failed"]);
  assert.equal(projected.runs[0].runId, projected.runIds[0]);
});

function rpcCall(args, { extraInit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", reject);
    child.on("close", () => {
      const lines = out.split("\n").filter(Boolean);
      const responses = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({ responses, stderr: err });
    });
    const initialize = { jsonrpc: "2.0", id: 0, method: "initialize" };
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "terrarium_spawn", arguments: args } };
    child.stdin.write(JSON.stringify(initialize) + "\n");
    child.stdin.write(JSON.stringify(call) + "\n");
    child.stdin.end();
    setTimeout(() => child.kill(), 15000).unref?.();
  });
}

test("MCP wire: terrarium_spawn dry-run returns concise shape by default", async () => {
  const { responses } = await rpcCall({ task: "concise test", dryRun: true });
  const call = responses.find((r) => r.id === 1);
  assert.ok(call?.result?.content?.[0]?.text, "expected tool-call result text");
  const parsed = JSON.parse(call.result.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, "done");
  assert.equal(typeof parsed.runId, "string");
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.task, undefined);
  assert.equal(parsed.cwd, undefined);
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.git, undefined);
  assert.equal(parsed.logPath, undefined);
  assert.equal(parsed.mreLogPath, undefined);
  assert.equal(parsed.invocation, undefined);
});

test("MCP wire: terrarium_spawn dry-run with verbose=true returns full envelope", async () => {
  const { responses } = await rpcCall({ task: "verbose test", dryRun: true, verbose: true });
  const call = responses.find((r) => r.id === 1);
  const parsed = JSON.parse(call.result.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(typeof parsed.task, "string");
  assert.equal(typeof parsed.cwd, "string");
  assert.equal(typeof parsed.agent, "string");
  assert.equal(typeof parsed.logPath, "string");
  assert.equal(typeof parsed.mreLogPath, "string");
  assert.equal(typeof parsed.invocation, "string");
});

test("MCP wire: concise default is meaningfully smaller than verbose", async () => {
  const [concise, verbose] = await Promise.all([
    rpcCall({ task: "size test", dryRun: true }),
    rpcCall({ task: "size test", dryRun: true, verbose: true }),
  ]);
  const conciseText = concise.responses.find((r) => r.id === 1).result.content[0].text;
  const verboseText = verbose.responses.find((r) => r.id === 1).result.content[0].text;
  assert.ok(conciseText.length < verboseText.length, `concise (${conciseText.length}B) should be smaller than verbose (${verboseText.length}B)`);
  assert.ok(conciseText.length < 1200, `concise dry-run spawn payload should be under 1.2 KB, got ${conciseText.length}`);
});
