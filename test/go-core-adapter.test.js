import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  dispatchMinimal,
  goCoreBinary,
  goCoreDryRun,
  goCoreEnabled,
  goCoreVersion,
  invokeGoCore,
  jsDryRunPlan,
} from "../src/go-core-adapter.ts";
import { VERSION } from "../src/core.js";
import { initialRunState } from "../src/run-machine.js";
import { clearInheritedTerrariumEnv } from "./helpers/terrarium-env.js";

clearInheritedTerrariumEnv();

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Compile the real Go core binary if a Go toolchain is available. Returns the
// binary path or null when Go is missing (the integration test self-skips).
function buildRealCore() {
  const probe = spawnSync("go", ["version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "terra-core-bin-"));
  const out = join(dir, "terra-core");
  const build = spawnSync("go", ["build", "-o", out, "./cmd/terra-core"], { cwd: repoRoot, encoding: "utf8" });
  if (build.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`go build failed: ${build.stderr || build.stdout}`);
  }
  return { dir, out };
}

// Build a throwaway "Go core" executable from a small node script. It speaks the
// same --stdin + envelope JSON contract the real Go binary does, so we exercise
// the adapter's transport and fallback logic without Go installed.
function fakeCore(body) {
  const dir = mkdtempSync(join(tmpdir(), "go-core-"));
  const path = join(dir, "core.mjs");
  const script = join(dir, "core");
  writeFileSync(path, body, "utf8");
  // A tiny shell shim so the binary is directly executable as a path.
  writeFileSync(script, `#!${process.execPath}\nimport("${path.replace(/"/g, '\\"')}");\n`, "utf8");
  chmodSync(script, 0o755);
  return { dir, script };
}

function envWith(binary) {
  return { ...process.env, TERRARIUM_GO_CORE: binary };
}

test("goCoreBinary / goCoreEnabled reflect TERRARIUM_GO_CORE", () => {
  assert.equal(goCoreBinary({}), null);
  assert.equal(goCoreBinary({ TERRARIUM_GO_CORE: "" }), null);
  assert.equal(goCoreBinary({ TERRARIUM_GO_CORE: "  " }), null);
  assert.equal(goCoreBinary({ TERRARIUM_GO_CORE: "/opt/core" }), "/opt/core");
  assert.equal(goCoreEnabled({}), false);
  assert.equal(goCoreEnabled({ TERRARIUM_GO_CORE: "/opt/core" }), true);
});

test("version falls back to JS when the Go core is disabled", () => {
  const out = goCoreVersion({});
  assert.equal(out.source, "js");
  assert.deepEqual(out.value, { version: VERSION, core: "js" });
});

test("version uses the Go core when versions match", () => {
  const { dir, script } = fakeCore(
    `console.log(JSON.stringify({ ok: true, apiVersion: "terrarium-api-2026-06-26", version: { core: "test", api: "terrarium-api-2026-06-26" } }));`,
  );
  try {
    const out = goCoreVersion(envWith(script));
    assert.equal(out.source, "go");
    assert.deepEqual(out.value, { version: VERSION, core: "go" });
    assert.equal(out.fallbackReason, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version falls back to JS on api mismatch (compat guard)", () => {
  const { dir, script } = fakeCore(`console.log(JSON.stringify({ ok: true, apiVersion: "bad-api", version: { core: "test", api: "bad-api" } }));`);
  try {
    const out = goCoreVersion(envWith(script));
    assert.equal(out.source, "js");
    assert.deepEqual(out.value, { version: VERSION, core: "js" });
    assert.match(out.fallbackReason, /api mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version falls back to JS on non-zero exit", () => {
  const { dir, script } = fakeCore(`process.exit(3);`);
  try {
    const out = goCoreVersion(envWith(script));
    assert.equal(out.source, "js");
    assert.match(out.fallbackReason, /exited 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version falls back to JS on unparseable output", () => {
  const { dir, script } = fakeCore(`console.log("not json at all");`);
  try {
    const out = goCoreVersion(envWith(script));
    assert.equal(out.source, "js");
    assert.match(out.fallbackReason, /unparseable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version falls back to JS when the binary is missing", () => {
  const out = goCoreVersion(envWith("/no/such/terrarium-core-binary"));
  assert.equal(out.source, "js");
  assert.ok(out.fallbackReason);
});

test("invokeGoCore drives the binary in --stdin mode with command in the envelope", () => {
  // The fake core reflects argv + parsed stdin so we can assert the wire format
  // matches cmd/terra-core's --stdin contract: the op rides inside the JSON
  // envelope's `command` field, NOT as argv[0], and argv[0] is "--stdin".
  const { dir, script } = fakeCore(`
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      console.log(JSON.stringify({ argv: process.argv.slice(2), payload: JSON.parse(input || "{}") }));
    });
  `);
  try {
    const run = invokeGoCore("status", { runId: "ter_x" }, envWith(script));
    assert.equal(run.spawned, true);
    assert.equal(run.status, 0);
    const parsed = JSON.parse(run.stdout);
    assert.deepEqual(parsed.argv, ["--stdin"], "binary must be invoked in --stdin protocol mode");
    assert.deepEqual(parsed.payload, { runId: "ter_x", command: "status" }, "op must travel in the command field alongside the payload");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invokeGoCore captures spawn failure without throwing when disabled", () => {
  const run = invokeGoCore("version", {}, {});
  assert.equal(run.spawned, false);
  assert.ok(run.error);
});

test("dispatchMinimal uses JS fallback when disabled and does call it once", async () => {
  let calls = 0;
  const out = await dispatchMinimal("status", {}, () => { calls++; return { ok: true }; }, {});
  assert.equal(out.source, "js");
  assert.deepEqual(out.value, { ok: true });
  assert.equal(calls, 1);
});

test("dispatchMinimal prefers Go core output and skips the JS fallback", async () => {
  const { dir, script } = fakeCore(`console.log(JSON.stringify({ source: "go-core", runs: [] }));`);
  let calls = 0;
  try {
    const out = await dispatchMinimal("status", {}, () => { calls++; return { source: "js" }; }, envWith(script));
    assert.equal(out.source, "go");
    assert.deepEqual(out.value, { source: "go-core", runs: [] });
    assert.equal(calls, 0, "JS fallback must not run on the Go happy path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatchMinimal falls back to JS on unparseable Go output", async () => {
  const { dir, script } = fakeCore(`console.log("<<garbage>>");`);
  let calls = 0;
  try {
    const out = await dispatchMinimal("dry-run", { task: "x" }, () => { calls++; return { dryRun: true }; }, envWith(script));
    assert.equal(out.source, "js");
    assert.deepEqual(out.value, { dryRun: true });
    assert.equal(calls, 1);
    assert.match(out.fallbackReason, /unparseable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Integration: the adapter must round-trip payload fields through the REAL Go
// binary's --stdin protocol. This is the regression guard for the wire-format
// mismatch where invoking [op, "--json"] caused the binary to ignore stdin and
// echo placeholder fields (runId/task == "--json") with a zero exit code.
test("invokeGoCore round-trips runId/task through the real terra-core binary", (t) => {
  let built;
  try {
    built = buildRealCore();
  } catch (err) {
    assert.fail(String(err));
  }
  if (!built) {
    t.skip("go toolchain not available");
    return;
  }
  try {
    const env = envWith(built.out);

    // status: the runId we send on stdin must come back verbatim, not "--json".
    const statusRun = invokeGoCore("status", { runId: "ter_real_round_trip" }, env);
    assert.equal(statusRun.spawned, true);
    assert.equal(statusRun.status, 0, statusRun.stderr);
    const status = JSON.parse(statusRun.stdout);
    assert.equal(status.ok, true);
    assert.equal(status.command, "status");
    assert.equal(status.status.runId, "ter_real_round_trip", "runId must survive the stdin round-trip");
    assert.notEqual(status.status.runId, "--json");

    // dry-run: the task we send on stdin must come back verbatim, not "--json".
    const dryRun = invokeGoCore("dry-run", { task: "render the widget", agent: "opencode run" }, env);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dry = JSON.parse(dryRun.stdout);
    assert.equal(dry.dryRun.task, "render the widget", "task must survive the stdin round-trip");
    assert.equal(dry.dryRun.agent, "opencode run");
    assert.notEqual(dry.dryRun.task, "--json");
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});

test("dispatchMinimal falls back to JS on non-zero Go exit", async () => {
  const { dir, script } = fakeCore(`process.exit(2);`);
  let calls = 0;
  try {
    const out = await dispatchMinimal("dry-run", {}, () => { calls++; return { dryRun: true }; }, envWith(script));
    assert.equal(out.source, "js");
    assert.equal(calls, 1);
    assert.match(out.fallbackReason, /exited 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// dry-run op: the second real read-only operation (beyond version) the Go core
// can serve, with a JS fallback + compatibility guard mirroring version.
// ---------------------------------------------------------------------------

// A fake core that emits a Go-shaped dry-run Response by echoing the stdin
// envelope back through the same projection the real binary applies.
function fakeDryRunCore() {
  return fakeCore(`
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      const cmd = JSON.parse(input || "{}");
      const requireReceipt = cmd.requireReceipt === undefined ? true : cmd.requireReceipt;
      console.log(JSON.stringify({
        ok: true,
        command: "dry-run",
        apiVersion: "terrarium-api-2026-06-26",
        dryRun: {
          task: cmd.task,
          agent: cmd.agent && cmd.agent.length ? cmd.agent : "opencode run",
          args: cmd.args || [],
          cwd: cmd.cwd && cmd.cwd.length ? cmd.cwd : ".",
          requireReceipt,
          initialState: {
            version: 1,
            phase: "running",
            requireReceipt,
            cancelRequested: false,
            deadlineReached: false,
            childExit: null,
            receipt: requireReceipt ? "pending" : "not-required",
            terminal: null,
          },
        },
      }));
    });
  `);
}

test("jsDryRunPlan computes the inert plan with defaults and run-machine state", () => {
  const plan = jsDryRunPlan({ task: "do a thing" });
  assert.equal(plan.task, "do a thing");
  assert.equal(plan.agent, "opencode run");
  assert.deepEqual(plan.args, []);
  assert.equal(plan.cwd, ".");
  assert.equal(plan.requireReceipt, true);
  assert.equal(plan.core, "js");
  assert.deepEqual(plan.initialState, initialRunState({ requireReceipt: true }));
});

test("jsDryRunPlan honors overrides including requireReceipt=false", () => {
  const plan = jsDryRunPlan({ task: "t", agent: "pi -p", cwd: "/work", requireReceipt: false });
  assert.equal(plan.agent, "pi -p");
  assert.equal(plan.cwd, "/work");
  assert.equal(plan.requireReceipt, false);
  assert.equal(plan.initialState.receipt, "not-required");
});

test("goCoreDryRun rejects an empty task", () => {
  assert.throws(() => goCoreDryRun({ task: "" }), /non-empty task/);
  assert.throws(() => goCoreDryRun({ task: "   " }), /non-empty task/);
});

test("goCoreDryRun falls back to JS when the Go core is disabled", () => {
  const out = goCoreDryRun({ task: "plan me" }, {});
  assert.equal(out.source, "js");
  assert.equal(out.value.core, "js");
  assert.deepEqual(out.value, jsDryRunPlan({ task: "plan me" }));
  assert.equal(out.fallbackReason, undefined);
});

test("goCoreDryRun uses the Go core and round-trips fields when api matches", () => {
  const { dir, script } = fakeDryRunCore();
  try {
    const out = goCoreDryRun({ task: "render the widget", agent: "pi -p", cwd: "/srv" }, envWith(script));
    assert.equal(out.source, "go");
    assert.equal(out.value.core, "go");
    assert.equal(out.value.task, "render the widget");
    assert.equal(out.value.agent, "pi -p");
    assert.equal(out.value.cwd, "/srv");
    assert.equal(out.value.requireReceipt, true);
    assert.deepEqual(out.value.initialState, initialRunState({ requireReceipt: true }));
    assert.equal(out.fallbackReason, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goCoreDryRun falls back to JS on api mismatch (compat guard)", () => {
  const { dir, script } = fakeCore(
    `console.log(JSON.stringify({ ok: true, command: "dry-run", apiVersion: "bad-api", dryRun: { task: "x", agent: "opencode run", args: [], cwd: ".", requireReceipt: true, initialState: {} } }));`,
  );
  try {
    const out = goCoreDryRun({ task: "x" }, envWith(script));
    assert.equal(out.source, "js");
    assert.match(out.fallbackReason, /api mismatch/);
    assert.deepEqual(out.value, jsDryRunPlan({ task: "x" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goCoreDryRun falls back to JS on a malformed payload", () => {
  const { dir, script } = fakeCore(
    `console.log(JSON.stringify({ ok: true, command: "dry-run", apiVersion: "terrarium-api-2026-06-26", dryRun: { task: 42 } }));`,
  );
  try {
    const out = goCoreDryRun({ task: "x" }, envWith(script));
    assert.equal(out.source, "js");
    assert.match(out.fallbackReason, /malformed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goCoreDryRun falls back to JS on non-zero exit", () => {
  const { dir, script } = fakeCore(`process.exit(4);`);
  try {
    const out = goCoreDryRun({ task: "x" }, envWith(script));
    assert.equal(out.source, "js");
    assert.match(out.fallbackReason, /exited 4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goCoreDryRun falls back to JS on unparseable output", () => {
  const { dir, script } = fakeCore(`console.log("not json");`);
  try {
    const out = goCoreDryRun({ task: "x" }, envWith(script));
    assert.equal(out.source, "js");
    assert.match(out.fallbackReason, /unparseable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goCoreDryRun falls back to JS when the binary is missing", () => {
  const out = goCoreDryRun({ task: "x" }, envWith("/no/such/terra-core"));
  assert.equal(out.source, "js");
  assert.ok(out.fallbackReason);
  assert.deepEqual(out.value, jsDryRunPlan({ task: "x" }));
});

test("goCoreDryRun matches the real terra-core binary when Go is available", (t) => {
  let built;
  try {
    built = buildRealCore();
  } catch (err) {
    assert.fail(String(err));
  }
  if (!built) {
    t.skip("go toolchain not available");
    return;
  }
  try {
    const out = goCoreDryRun({ task: "ship it", agent: "opencode run", cwd: "." }, envWith(built.out));
    assert.equal(out.source, "go", out.fallbackReason);
    assert.equal(out.value.task, "ship it");
    assert.equal(out.value.agent, "opencode run");
    assert.equal(out.value.requireReceipt, true);
    // Go core must agree with the JS source of truth for the initial state.
    assert.deepEqual(out.value.initialState, jsDryRunPlan({ task: "ship it" }).initialState);
  } finally {
    rmSync(built.dir, { recursive: true, force: true });
  }
});
