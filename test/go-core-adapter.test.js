import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchMinimal,
  goCoreBinary,
  goCoreEnabled,
  goCoreVersion,
  invokeGoCore,
} from "../src/go-core-adapter.ts";
import { VERSION } from "../src/core.js";
import { clearInheritedTerrariumEnv } from "./helpers/terrarium-env.js";

clearInheritedTerrariumEnv();

// Build a throwaway "Go core" executable from a small node script. It speaks the
// same op/--json + stdin/stdout JSON contract the real Go binary would, so we
// exercise the adapter's transport and fallback logic without Go installed.
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

test("invokeGoCore echoes the op and stdin payload to the core", () => {
  // The fake core reflects argv + parsed stdin so we can assert the wire format.
  const { dir, script } = fakeCore(`
    let input = "";
    process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => {
      console.log(JSON.stringify({ op: process.argv[2], json: process.argv[3], payload: JSON.parse(input || "{}") }));
    });
  `);
  try {
    const run = invokeGoCore("status", { runId: "ter_x" }, envWith(script));
    assert.equal(run.spawned, true);
    assert.equal(run.status, 0);
    const parsed = JSON.parse(run.stdout);
    assert.deepEqual(parsed, { op: "status", json: "--json", payload: { runId: "ter_x" } });
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
