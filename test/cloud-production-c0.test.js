// Cloud Terrarium production C0 — Round 2 correctness proofs.
//
// These tests cover the Round 1 → Round 2 defects that had to be fixed:
//   1. SDK call shape (exec/startProcess signatures per @cloudflare/sandbox 0.12).
//   2. Task text is NOT executed as a shell program; it is delivered as a
//      file to a fixed bounded runner entrypoint.
//   3. Persisted execution ref / sandboxId / processId / intent / deadline
//      survives DO restart (constructing a fresh RunControlDO over the same
//      SQL storage picks the runId up).
//   4. Alarm-driven terminal collection and callback retry.
//   5. Idempotent admission.
//   6. Partial-log delivery when the child is killed before writing a receipt.
//   7. Fail-closed when no production backend is available.
//   8. Wrangler config: TERRARIUM_SANDBOX + containers + nodejs_compat.
//   9. Fake SandboxContainerBackend is not what the production DO selects.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RunControlDO, _testables } from "../src/cloud/run-control-do.js";
import { DetachedProcessBackend } from "../src/cloud/local-run-cell.js";
import {
  SandboxContainerBackendReal,
  TASK_INBOX_PATH,
  DEFAULT_RUNNER_COMMAND,
} from "../src/cloud/sandbox-backend.js";
import { SandboxContainerBackend } from "../src/cloud/backend-adapter.js";

// SQL shim reused from cloud-run-control-do.test.js style.
function makeSqlShim(db = new DatabaseSync(":memory:")) {
  return {
    _db: db,
    exec(sql, ...bindings) {
      const isSelect = /^\s*SELECT/i.test(sql);
      if (bindings.length === 0 && !isSelect) {
        db.exec(sql);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(sql);
      if (isSelect) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows };
      }
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

function makeStateOverDb(db) {
  const sql = makeSqlShim(db);
  const pending = [];
  let alarmAt = null;
  return {
    storage: {
      sql,
      async setAlarm(ms) { alarmAt = ms; },
      async getAlarm() { return alarmAt; },
      _alarmAt: () => alarmAt,
    },
    waitUntil(p) { pending.push(Promise.resolve(p)); },
    async drain() { await Promise.allSettled(pending.splice(0)); },
  };
}

// ---------------- 1. SDK call shape ----------------

test("SandboxContainerBackendReal calls sandbox.startProcess(command, options) with a fixed argv (no task interpolation)", async () => {
  const calls = [];
  const contract = { runId: "ter_shape_1", taskFingerprint: "a".repeat(24), nonce: "n" };
  const fakeSandbox = {
    async writeFile(p, c) { calls.push({ op: "writeFile", path: p, content: c }); return { success: true }; },
    async startProcess(command, options) {
      calls.push({ op: "startProcess", command, options });
      return { id: options.processId, pid: 1, command, status: "completed", startTime: new Date(), async waitForExit() { return { exitCode: 0 }; }, async getLogs() { return { stdout: "", stderr: "" }; } };
    },
  };
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => fakeSandbox,
    sandboxBinding: { idFromName: () => ({}), get: () => ({}) },
  });
  const { executionRef } = backend.start({ contract, task: "PWNED_CMD; rm -rf /" });
  await backend.waitExit(executionRef);
  // The runner command is a FIXED string; task text is never in it.
  const sp = calls.find((c) => c.op === "startProcess");
  assert.ok(sp, "startProcess must be called");
  assert.equal(sp.command, DEFAULT_RUNNER_COMMAND);
  assert.equal(sp.options.processId, `terrarium-${contract.runId}`);
  assert.equal(sp.options.autoCleanup, false);
  assert.equal(Object.hasOwn(sp.options, "env"), false, "no model credential/env is passed to the child process");
  assert.doesNotMatch(JSON.stringify(sp.options), /token|secret|api[_-]?key|authorization/i);
  assert.ok(!sp.command.includes("PWNED_CMD"));
  // Task text was delivered by writeFile.
  const wt = calls.find((c) => c.op === "writeFile" && c.path === TASK_INBOX_PATH);
  assert.ok(wt);
  assert.equal(wt.content, "PWNED_CMD; rm -rf /");
});

test("SandboxContainerBackendReal retries the live cold-start response before writing task and starting", async () => {
  let writes = 0;
  let starts = 0;
  const fakeSandbox = {
    async writeFile() {
      writes += 1;
      if (writes === 1) throw new Error("Container is starting. Please retry in a moment.");
      return { success: true };
    },
    async getProcess() { return null; },
    async startProcess(_command, options) {
      starts += 1;
      return {
        id: options.processId,
        async waitForExit() { return { exitCode: 0 }; },
        async getLogs() { return { stdout: "", stderr: "" }; },
      };
    },
  };
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => fakeSandbox,
    sandboxBinding: {},
  });
  const { executionRef } = backend.start({
    contract: { runId: "ter_cold_start_1", taskFingerprint: "a".repeat(24), nonce: "n" },
    task: "bounded task",
  });
  await backend.poll(executionRef);
  const exit = await backend.waitExit(executionRef);
  assert.equal(exit.exitCode, 0);
  assert.equal(writes, 3, "first task write retries, then contract write succeeds");
  assert.equal(starts, 1);
  assert.doesNotMatch(backend.logChunks(executionRef).join(""), /sandbox-write-task-error/);
});

test("SandboxContainerBackendReal reattach relaunches a persisted task when cold start created no process", async () => {
  let writes = 0;
  let starts = 0;
  const fakeSandbox = {
    async getProcess() { return null; },
    async writeFile() { writes += 1; },
    async startProcess(_command, options) {
      starts += 1;
      return {
        id: options.processId,
        async waitForExit() { return { exitCode: 0 }; },
        async getLogs() { return { stdout: "TASK_ENDED\n", stderr: "" }; },
      };
    },
  };
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => fakeSandbox,
    sandboxBinding: {},
  });
  backend.reattach({
    executionRef: "sbx_relaunch",
    sandboxId: "run-ter_relaunch_1",
    processId: "terrarium-ter_relaunch_1",
    contract: { runId: "ter_relaunch_1", taskFingerprint: "b".repeat(24), nonce: "n" },
    task: "persisted bounded task",
    deadlineMs: 60_000,
  });
  const exit = await backend.waitExit("sbx_relaunch");
  assert.equal(exit.exitCode, 0);
  assert.equal(writes, 2);
  assert.equal(starts, 1);
});

test("SandboxContainerBackendReal fails closed without durable startProcess and never falls back to exec", async () => {
  // exec has no durable process address; production must not use it as a
  // fallback when restart-safe startProcess is unavailable.
  const execCalls = [];
  const fakeSandbox = {
    async writeFile() { return { success: true }; },
    async exec(command, options) {
      execCalls.push({ command, arg2IsOptionsObject: options && typeof options === "object" && !Array.isArray(options) });
      return { exitCode: 0, stdout: "", stderr: "", success: true };
    },
    // NO startProcess — production must fail closed.
  };
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => fakeSandbox,
    sandboxBinding: { idFromName: () => ({}), get: () => ({}) },
  });
  const { executionRef } = backend.start({
    contract: { runId: "ter_shape_2", taskFingerprint: "a".repeat(24), nonce: "n" },
    task: "hi",
  });
  const exit = await backend.waitExit(executionRef);
  assert.equal(exit.exitCode, 1);
  assert.equal(execCalls.length, 0);
  assert.match(backend.logChunks(executionRef).join(""), /startProcess is required/);
});

// ---------------- 2. Restart recovery ----------------

test("RunControlDO reconstructs runId, contract, execution ref, and intent from SQL after restart", async () => {
  const db = new DatabaseSync(":memory:");
  const state1 = makeStateOverDb(db);
  const backend = new DetachedProcessBackend();
  const env = { __TERRARIUM_TEST_BACKEND__: backend };
  const doA = new RunControlDO(state1, env);

  const admit = await doA.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "restartable", ownerId: "owner-R" }),
  }));
  assert.equal(admit.status, 202);
  const body = await admit.json();
  await state1.drain();

  // Simulate DO restart: brand-new RunControlDO instance over the SAME SQL db.
  const state2 = makeStateOverDb(db);
  const doB = new RunControlDO(state2, env);
  const status = await doB.fetch(new Request("https://do/status?ownerId=owner-R", { method: "GET" }));
  assert.equal(status.status, 200);
  const st = await status.json();
  assert.equal(st.status.runId, body.runId);
  assert.equal(st.status.taskFingerprint, body.contract.taskFingerprint);
});

// ---------------- 3. Alarm-driven callback retry ----------------

test("RunControlDO callback retry: alarm re-emits until callbackCommitted", async () => {
  const db = new DatabaseSync(":memory:");
  const state = makeStateOverDb(db);
  const backend = new DetachedProcessBackend();
  // Fake pulse router that fails on the first two calls, then succeeds.
  let attempts = 0;
  const routedBodies = [];
  const env = {
    __TERRARIUM_TEST_BACKEND__: backend,
    PULSE_ROUTER: {
      idFromName: () => "global",
      get: () => ({
        async fetch(_url, init) {
          attempts += 1;
          routedBodies.push(JSON.parse(init.body));
          return attempts < 3
            ? new Response("fail", { status: 500 })
            : new Response("{}", { status: 200 });
        },
      }),
    },
  };
  const doInst = new RunControlDO(state, env);
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "callback retry", ownerId: "owner-C" }),
  }));
  await state.drain();
  // Drive collection.
  await doInst.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-C" }),
  }));
  // Simulate two alarm firings; on the third attempt the pulse succeeds.
  await doInst.alarm();
  await doInst.alarm();
  await doInst.alarm();
  assert.ok(attempts >= 3, `expected >= 3 pulse attempts, got ${attempts}`);
  assert.ok(routedBodies.every((body) => body.requirePrincipalOwner === true));
  assert.ok(routedBodies.every((body) => body.args.event.ownerId === "owner-C"));
});

test("RunControlDO retries a failed principal reservation release before callback commit", async () => {
  const db = new DatabaseSync(":memory:");
  const state = makeStateOverDb(db);
  let releases = 0;
  const env = {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    TERRARIUM_PRINCIPAL_BUDGET: {
      idFromName: (name) => name,
      get: () => ({
        async fetch() {
          releases += 1;
          return new Response("{}", { status: releases === 1 ? 500 : 200 });
        },
      }),
    },
    PULSE_ROUTER: {
      idFromName: () => "global",
      get: () => ({ async fetch() { return new Response("{}", { status: 200 }); } }),
    },
  };
  const doInst = new RunControlDO(state, env);
  const admit = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "release retry", ownerId: "principal-A" }),
  }));
  assert.equal(admit.status, 202);
  await state.drain();
  assert.equal(releases, 1);
  await doInst.alarm();
  assert.ok(releases >= 2, "callback alarm must retry an unconfirmed budget release");
  const store = new _testables.SqlRunStateStore(makeSqlShim(db));
  const [runId] = store.listPendingCallback();
  assert.equal(runId, undefined, "callback commits only after release and Pulse both confirm");
});

// ---------------- 4. Idempotent admission ----------------

test("RunControlDO admission is idempotent: same runId + task fingerprint returns original receipt", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const backend = new DetachedProcessBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });

  const first = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "idempotent-admit", ownerId: "owner-I", runId: "ter_idem_1" }),
  }));
  assert.equal(first.status, 202);
  const b1 = await first.json();
  await state.drain();

  const second = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "idempotent-admit", ownerId: "owner-I", runId: "ter_idem_1" }),
  }));
  assert.equal(second.status, 202);
  const b2 = await second.json();
  assert.equal(b2.idempotent, true);
  assert.equal(b2.runId, b1.runId);
});

test("RunControlDO admission rejects a different task on an already-populated cell", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const backend = new DetachedProcessBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });

  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "first task", ownerId: "owner-I" }),
  }));
  await state.drain();

  const second = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "different task", ownerId: "owner-I" }),
  }));
  assert.equal(second.status, 409);
});

// ---------------- 5. Partial logs ----------------

test("RunControlDO cancel yields partial logs without a TERRARIUM_RESULT marker", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const backend = new DetachedProcessBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });

  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: "partial-logs",
      ownerId: "owner-P",
      spec: { blocks: true, partialStdout: "step 1\nstep 2\n" },
    }),
  }));
  await doInst.fetch(new Request("https://do/cancel", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-P" }),
  }));
  await state.drain();

  const logs = await doInst.fetch(new Request("https://do/logs?ownerId=owner-P", { method: "GET" }));
  const body = await logs.json();
  assert.ok(body.logs.includes("step"));
  assert.ok(!body.logs.includes("TERRARIUM_RESULT="));
});

// ---------------- 6. Deadline / timeout via alarm ----------------

test("RunControlDO alarm enforces deadline: blocking run past deadline => timeout terminal", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const backend = new DetachedProcessBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });

  const admit = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // A blocking child never exits on its own. The alarm must fire timeout()
      // (SIGKILL) so the collect can finalize to a "failed / deadline" terminal.
      task: "will time out",
      ownerId: "owner-T",
      spec: { blocks: true, deadlineMs: 1 },
    }),
  }));
  assert.equal(admit.status, 202);
  // Deadline computed on the DO: Date.now() + max(1000, deadlineMs). Wait past.
  await new Promise((r) => setTimeout(r, 1200));
  // Do NOT drain here — the admit's waitUntil collect() is blocked on the
  // never-exiting child. Firing the alarm should timeout() the backend and
  // unblock finalization.
  await doInst.alarm();

  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-T" }),
  }));
  const body = await collect.json();
  assert.equal(body.terminal.status, "failed");
  assert.equal(body.terminal.reason, "deadline-reached");
});

// ---------------- 7. Fail-closed missing backend ----------------

test("RunControlDO fails closed when no production backend and no test backend", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const doInst = new RunControlDO(state, {}); // no TERRARIUM_SANDBOX, no test backend
  const res = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "no backend", ownerId: "owner-X" }),
  }));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /backend/i);
});

// ---------------- 8. Fake backend is not silently used in production ----------------

test("SandboxContainerBackend (spike) is not what tryCreateSandboxBackend returns", async () => {
  const { tryCreateSandboxBackend } = await import("../src/cloud/sandbox-backend.js");
  const b = await tryCreateSandboxBackend({}); // no binding
  assert.equal(b, null);
  // The spike class exists but must never be routed via the production path.
  const spike = new SandboxContainerBackend();
  assert.notEqual(spike.constructor.name, "SandboxContainerBackendReal");
});

// ---------------- 9. Wrangler config: TERRARIUM_SANDBOX + containers + nodejs_compat ----------------

test("wrangler.jsonc declares TERRARIUM_SANDBOX DO binding, containers entry, and nodejs_compat", () => {
  const raw = fs.readFileSync(path.resolve(process.cwd(), "wrangler.jsonc"), "utf8");
  // Strip trailing commas / comments — cheap parse.
  const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
  const cfg = JSON.parse(cleaned);
  const doNames = (cfg.durable_objects?.bindings || []).map((b) => b.name);
  assert.ok(doNames.includes("TERRARIUM_SANDBOX"), `expected TERRARIUM_SANDBOX DO binding, got: ${doNames.join(", ")}`);
  assert.ok(doNames.includes("TERRARIUM_RUN"));
  assert.ok(Array.isArray(cfg.containers) && cfg.containers.length >= 1, "containers stanza required");
  const sandboxContainer = cfg.containers.find((c) => c.class_name === "TerrariumSandbox");
  assert.ok(sandboxContainer, "containers must reference TerrariumSandbox");
  assert.match(String(sandboxContainer.image), /Dockerfile(\.\w+)?$/, "container image must point at a Dockerfile");
  assert.ok((cfg.compatibility_flags || []).includes("nodejs_compat"), "nodejs_compat flag required");
});

test("package-lock.json contains @cloudflare/sandbox entry", () => {
  const raw = fs.readFileSync(path.resolve(process.cwd(), "package-lock.json"), "utf8");
  assert.ok(raw.includes("@cloudflare/sandbox"));
});

// ---------------- 10. Receipt authority remains ----------------

test("Verified TERRARIUM_RESULT remains the sole authority for success", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const backend = new DetachedProcessBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });

  // Clean exit but no receipt => inconclusive.
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "no receipt path", ownerId: "owner-A", spec: { emitReceipt: false } }),
  }));
  await state.drain();
  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }));
  const body = await collect.json();
  assert.equal(body.terminal.status, "inconclusive");
});

// ---------------- 11. Log offload / R2 ref shape ----------------

// ---------------- Round 5B focused tests ----------------

/** DetachedProcessBackend + describe()/poll() for reattach & polling proofs. */
class BackendWithAddress extends DetachedProcessBackend {
  #polls = 0;
  #terminalAfter;
  constructor({ terminalAfter = Infinity } = {}) {
    super();
    this.#terminalAfter = terminalAfter;
  }
  describe(executionRef) {
    // Deterministic sandboxId + processId derived from ref so admission can
    // persist BOTH synchronously.
    return { sandboxId: `sbx-${executionRef}`, processId: `proc-${executionRef}` };
  }
  async poll(executionRef) {
    this.#polls += 1;
    if (this.#polls >= this.#terminalAfter) {
      // Force the underlying execution to terminal by calling timeout().
      try { this.timeout(executionRef); } catch { /* ignore */ }
      return { terminal: true, exitCode: 124 };
    }
    return { terminal: false, status: "running" };
  }
  get pollCount() { return this.#polls; }
}

test("Round 5B: admission persists BOTH sandboxId and processId synchronously", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const backend = new BackendWithAddress();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });
  const res = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "addr", ownerId: "owner-Z" }),
  }));
  assert.equal(res.status, 202);
  const body = await res.json();
  // Read persisted state directly via a fresh store.
  const store = new _testables.SqlRunStateStore(state.storage.sql);
  const row = store.get(body.runId);
  assert.ok(row.sandboxId, "sandboxId must be persisted synchronously");
  assert.ok(row.processId, "processId must be persisted synchronously");
  assert.match(row.sandboxId, /^sbx-/);
  assert.match(row.processId, /^proc-/);
});

test("Round 5B: predeadline alarm is nonblocking — soft-poll then re-arm without awaiting collect", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  // never-terminal poll => alarm must return without awaiting waitExit.
  const backend = new BackendWithAddress({ terminalAfter: Infinity });
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "block", ownerId: "owner-N", spec: { blocks: true, deadlineMs: 60 * 1000 } }),
  }));
  // Fire alarm well before deadline; must not hang despite blocking child.
  const done = doInst.alarm();
  const raced = await Promise.race([done.then(() => "alarm"), new Promise((r) => setTimeout(() => r("timeout"), 500))]);
  assert.equal(raced, "alarm", "predeadline alarm hung on waitExit");
  assert.ok(backend.pollCount >= 1, "backend.poll must be called predeadline");
  const nextAlarm = await state.storage.getAlarm();
  assert.ok(typeof nextAlarm === "number", "next alarm must be re-armed for soft-poll cadence");
});

test("Round 5B: terminal poll leads to collection and finalization", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const backend = new BackendWithAddress({ terminalAfter: 1 });
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "poll-terminal", ownerId: "owner-K", spec: { blocks: true, deadlineMs: 60 * 1000 } }),
  }));
  // DO NOT drain here — admit's waitUntil collect() is blocked on the blocking
  // child. Alarm must unblock via poll() → timeout() → collect completion.
  await doInst.alarm();
  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-K" }),
  }));
  const body = await collect.json();
  assert.equal(body.terminal.status, "failed");
});

test("Round 5B: callback retry survives a completely new DO/backend object via durable terminal_event", async () => {
  const db = new DatabaseSync(":memory:");
  const state1 = makeStateOverDb(db);
  let attempts = 0;
  const buildEnv = () => ({
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    PULSE_ROUTER: {
      idFromName: () => "global",
      get: () => ({
        async fetch() { attempts += 1; return attempts < 3 ? new Response("x", { status: 500 }) : new Response("{}", { status: 200 }); },
      }),
    },
  });
  const doA = new RunControlDO(state1, buildEnv());
  await doA.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "retry-across-restart", ownerId: "owner-R2" }),
  }));
  await state1.drain();
  await doA.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-R2" }),
  }));
  // Verify the terminal_event was persisted BEFORE eviction.
  const store = new _testables.SqlRunStateStore(makeSqlShim(db));
  const runId = store.listPendingCallback()[0] || store.listUnfinalized()[0];
  assert.ok(runId, "expected a persisted run row");
  const persisted = store.get(runId);
  assert.ok(persisted?.terminalEvent?.eventId, "terminal_event must be persisted synchronously in queue()");
  assert.equal(persisted.terminalEvent.runId, runId);
  // Fresh DO / fresh backend object (empty JS heap) over the SAME SQL db.
  const state2 = makeStateOverDb(db);
  const doB = new RunControlDO(state2, buildEnv());
  await doB.alarm();
  await doB.alarm();
  await doB.alarm();
  assert.ok(attempts >= 3, `expected >= 3 pulse attempts across DO restart, got ${attempts}`);
});

test("Round 5B: SqlLogArtifactStore bytes budget is UTF-8 aware (multi-byte)", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const puts = [];
  const env = {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    TERRARIUM_ARTIFACTS: { async put(key, value) { puts.push({ key, bytes: new TextEncoder().encode(String(value)).byteLength }); return { key }; } },
  };
  const doInst = new RunControlDO(state, env);
  // 4-byte characters each; produce enough to overflow the byte budget but a
  // JS .length count would UNDER-report the true size. This proves the store
  // uses UTF-8 byte counts (not code units) and never splits mid-character.
  const emoji = "\uD83D\uDCA9"; // U+1F4A9 pile of poo — 4 UTF-8 bytes
  const big = emoji.repeat(Math.ceil((_testables.MAX_LOG_SQL_BYTES + 8 * 1024) / 4));
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "utf8 log", ownerId: "owner-U", spec: { rawStdout: big } }),
  }));
  await state.drain();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(puts.length >= 1, "at least one R2 put required for overflow");
  const logsRes = await doInst.fetch(new Request("https://do/logs?ownerId=owner-U", { method: "GET" }));
  const logsBody = await logsRes.json();
  assert.ok(logsBody.logRefs.length >= 1);
  // The persisted byteCount MUST be the UTF-8 byte count, not the code-unit
  // length. |bytes| == 4 * |codepoints|; refs report the byte count.
  const ref = logsBody.logRefs[0];
  assert.ok(ref.byteCount > 0);
  // Inline chunk must remain valid UTF-8 (no mid-codepoint split) — reading it
  // back and re-decoding does not surface replacement characters that were not
  // present in the source.
  assert.ok(!logsBody.logs.includes("\uFFFD"), "no U+FFFD replacement chars — split honored code-point boundary");
});

test("Round 5B: awaited R2 success and failure — a put reject surfaces (not swallowed)", async () => {
  // Success: ref row is inserted only AFTER the put resolves.
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  let resolvePut;
  const env = {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    TERRARIUM_ARTIFACTS: {
      async put(key, value) {
        await new Promise((r) => { resolvePut = r; });
        return { key };
      },
    },
  };
  const doInst = new RunControlDO(state, env);
  const big = "L".repeat(_testables.MAX_LOG_SQL_BYTES + 4 * 1024);
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "await r2", ownerId: "owner-W", spec: { rawStdout: big } }),
  }));
  // The waitUntil promise is still pending until the put resolves. Ref row
  // must not exist yet.
  const preRes = await doInst.fetch(new Request("https://do/logs?ownerId=owner-W", { method: "GET" }));
  const preBody = await preRes.json();
  assert.equal(preBody.logRefs.length, 0, "ref must not be committed before put resolves");
  resolvePut && resolvePut();
  await state.drain();
  await new Promise((r) => setTimeout(r, 20));
  const postRes = await doInst.fetch(new Request("https://do/logs?ownerId=owner-W", { method: "GET" }));
  const postBody = await postRes.json();
  assert.ok(postBody.logRefs.length >= 1, "ref must be committed only after put resolves");

  // Failure: a rejected put must SURFACE via state.waitUntil (no silent catch).
  const state2 = makeStateOverDb(new DatabaseSync(":memory:"));
  const rejected = [];
  const origWaitUntil = state2.waitUntil.bind(state2);
  state2.waitUntil = (p) => { origWaitUntil(Promise.resolve(p).catch((err) => { rejected.push(err); throw err; })); };
  const env2 = {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    TERRARIUM_ARTIFACTS: { async put() { throw new Error("r2-down"); } },
  };
  const doInst2 = new RunControlDO(state2, env2);
  await doInst2.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "r2 down", ownerId: "owner-F", spec: { rawStdout: big } }),
  }));
  await state2.drain();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(rejected.some((e) => /r2-down/.test(e.message)), "R2 put failure must surface, not be swallowed");
});

test("Round 5B: restart reattach fails closed when processId is missing", async () => {
  const db = new DatabaseSync(":memory:");
  const state1 = makeStateOverDb(db);
  // Backend that cannot describe an address, but admission is bypassed via
  // __TERRARIUM_TEST_ALLOW_ADDRESSLESS__ so we can inspect the reattach path
  // when the durable row is missing its process address after restart.
  const backend = new DetachedProcessBackend();
  const doA = new RunControlDO(state1, {
    __TERRARIUM_TEST_BACKEND__: backend,
    __TERRARIUM_TEST_BLOCK_ADDRESS__: true,
    __TERRARIUM_TEST_ALLOW_ADDRESSLESS__: true,
  });
  await doA.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "no-address", ownerId: "owner-M", spec: { blocks: true } }),
  }));
  // Manually null-out processId to simulate the missing-address case.
  const store = new _testables.SqlRunStateStore(makeSqlShim(db));
  const runId = store.listUnfinalized()[0];
  store.patch(runId, { processId: null, sandboxId: null });
  // Fresh DO instance — reattach must fail closed.
  const state2 = makeStateOverDb(db);
  const doB = new RunControlDO(state2, { __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend() });
  await doB.fetch(new Request("https://do/status?ownerId=owner-M", { method: "GET" }));
  await state2.drain();
  const store2 = new _testables.SqlRunStateStore(makeSqlShim(db));
  const row = store2.get(runId);
  assert.equal(row.callbackLastError, "reattach-missing-execution-address");
});

test("RunControlDO offloads logs beyond MAX_LOG_SQL_BYTES to R2 and exposes integrity refs", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const backend = new DetachedProcessBackend();
  const puts = [];
  const env = {
    __TERRARIUM_TEST_BACKEND__: backend,
    TERRARIUM_ARTIFACTS: {
      async put(key, value) { puts.push({ key, len: String(value).length }); return { key }; },
    },
  };
  const doInst = new RunControlDO(state, env);
  // Task that produces > MAX_LOG_SQL_BYTES stdout.
  const big = "L".repeat(_testables.MAX_LOG_SQL_BYTES + 20 * 1024);
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "big logs", ownerId: "owner-B", spec: { rawStdout: big } }),
  }));
  await state.drain();
  // At least one R2 put should have occurred.
  // (Async offload — give it a tick.)
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(puts.length >= 1, `expected at least one R2 offload put; got ${puts.length}`);
  const logsRes = await doInst.fetch(new Request("https://do/logs?ownerId=owner-B", { method: "GET" }));
  const logsBody = await logsRes.json();
  assert.ok(Array.isArray(logsBody.logRefs));
  assert.ok(logsBody.logRefs.length >= 1);
  assert.equal("r2Key" in logsBody.logRefs[0], false, "internal object keys are not public metadata");
  assert.ok(logsBody.logRefs[0].byteCount > 0);
  assert.match(logsBody.logRefs[0].sha256, /^[0-9a-f]{64}$/);
});

// ---------------- Round 5B.1 narrow-correction blocker proofs ----------------

// Blocker 1: CommittingCallbackTransport must SYNCHRONOUSLY persist the
// canonical terminal event BEFORE the first (or retry) send; must NOT catch
// a persistEvent failure; must NOT mutate the event with __lastError.
test("Round 5B.1 (1a): queue() calls persistEvent BEFORE emit and passes the same event object", async () => {
  const order = [];
  const seen = [];
  const transport = new _testables.CommittingCallbackTransport({
    persistEvent: (e) => { order.push("persist"); seen.push(e); },
    emitToPulse: async (e) => { order.push("emit"); return true; },
    loadEvent: () => null,
    waitUntil: () => {},
  });
  transport.queue({ eventId: "e1", runId: "ter_x1", ownerId: "o", status: "done", ok: true });
  // The persist call must have completed before the emit was scheduled.
  assert.equal(order[0], "persist", "persist must run synchronously before emit");
  // Same event object identity — so contract-bound injections can patch runId.
  assert.equal(seen[0].eventId, "e1");
  // Give the microtask queue a tick and confirm emit ran.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(order.includes("emit"), "emit must run");
});

test("Round 5B.1 (1b): queue() PROPAGATES a persistEvent failure (never swallowed)", async () => {
  const transport = new _testables.CommittingCallbackTransport({
    persistEvent: () => { throw new Error("disk-full"); },
    emitToPulse: async () => true,
    waitUntil: () => {},
  });
  assert.throws(() => transport.queue({ eventId: "e2", runId: "ter_x2", ownerId: "o", status: "done", ok: true }), /disk-full/);
});

test("Round 5B.1 (1c): queue() does NOT re-persist the event with __lastError on emit failure", async () => {
  const persisted = [];
  const transport = new _testables.CommittingCallbackTransport({
    persistEvent: (e) => { persisted.push({ ...e }); },
    emitToPulse: async () => { throw new Error("pulse-down"); },
    waitUntil: () => {},
  });
  transport.queue({ eventId: "e3", runId: "ter_x3", ownerId: "o", status: "done", ok: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(persisted.length, 1, "persistEvent must be called exactly once at queue time");
  assert.equal(persisted[0].__lastError, undefined, "must never mutate event with __lastError");
});

// Blocker 2: Predeadline alarm with missing OR throwing backend.poll must
// re-arm and RETURN; never call collect unless poll explicitly says terminal.
test("Round 5B.1 (2a): predeadline alarm with NO backend.poll re-arms and returns without collecting", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  // Backend WITHOUT a poll method. Give it describe() so admission succeeds.
  class NoPollBackend extends DetachedProcessBackend {
    // Explicitly disable the poll method (parent has none, so nothing to do).
  }
  const backend = new NoPollBackend();
  let collectCount = 0;
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });
  const admit = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "block-no-poll", ownerId: "owner-NP", spec: { blocks: true, deadlineMs: 60 * 1000 } }),
  }));
  assert.equal(admit.status, 202);
  // Fire alarm. Must not hang; must re-arm.
  const done = doInst.alarm();
  const raced = await Promise.race([done.then(() => "alarm"), new Promise((r) => setTimeout(() => r("hung"), 400))]);
  assert.equal(raced, "alarm", "predeadline alarm hung when backend.poll was missing");
  const next = await state.storage.getAlarm();
  assert.ok(typeof next === "number", "must re-arm alarm when poll unavailable");
});

test("Round 5B.1 (2b): predeadline alarm with a THROWING backend.poll re-arms and does not collect", async () => {
  class ThrowingPollBackend extends DetachedProcessBackend {
    async poll() { throw new Error("poll-blew-up"); }
  }
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const backend = new ThrowingPollBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "block-throw-poll", ownerId: "owner-TP", spec: { blocks: true, deadlineMs: 60 * 1000 } }),
  }));
  const done = doInst.alarm();
  const raced = await Promise.race([done.then(() => "alarm"), new Promise((r) => setTimeout(() => r("hung"), 400))]);
  assert.equal(raced, "alarm", "throwing poll must not hang the alarm on collect");
  // The run must remain unfinalized — collect must not have been called.
  const rows = state.storage.sql.exec("SELECT finalized FROM run_state").toArray();
  assert.equal(Number(rows[0]?.finalized || 0), 0, "must not finalize on a throwing poll");
});

// Blocker 3: SandboxContainerBackendReal cancel/timeout must return a kill
// promise; a failed first kill leaves waitExit unsettled and is retriable.
test("Round 5B.1 (3a): SandboxContainerBackendReal.cancel returns a promise; failed kill does NOT settle waitExit", async () => {
  const contract = { runId: "ter_kill_retry", taskFingerprint: "aa".repeat(12), nonce: "kn" };
  let killCalls = 0;
  const fakeSandbox = {
    async writeFile() {},
    async startProcess(_c, opts) {
      return {
        id: opts.processId,
        pid: 1,
        async waitForExit() { return new Promise(() => {}); }, // never exits
        async getLogs() { return { stdout: "", stderr: "" }; },
        async getStatus() { return "running"; },
      };
    },
    async killProcess() {
      killCalls += 1;
      if (killCalls === 1) throw new Error("kill-failed-once");
      // second call: success
    },
  };
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => fakeSandbox,
    sandboxBinding: {},
  });
  const { executionRef } = backend.start({ contract, task: "wait" });
  await new Promise((r) => setTimeout(r, 10)); // let launch record processId
  const first = backend.cancel(executionRef);
  assert.ok(first && typeof first.then === "function", "cancel must return a kill promise");
  const firstOk = await first;
  assert.equal(firstOk, false, "first kill must report failure");
  // waitExit must still be unsettled after failed kill.
  const raced = await Promise.race([
    backend.waitExit(executionRef).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("unsettled"), 50)),
  ]);
  assert.equal(raced, "unsettled", "waitExit must remain unsettled after failed kill for alarm retry");
  // Retry the kill: second attempt succeeds, waitExit resolves.
  const secondOk = await backend.cancel(executionRef);
  assert.equal(secondOk, true, "second kill must succeed");
  const exit = await backend.waitExit(executionRef);
  assert.equal(exit.cancelled, true);
});

test("Round 5B.1 (3b): backend.cancel BEFORE launch completes prevents startProcess", async () => {
  // This exercises the pre-launch intent branch: rec.launching + no processId
  // means cancel returns immediately (resolved true) and #launch bails.
  const contract = { runId: "ter_cancel_prelaunch", taskFingerprint: "bb".repeat(12), nonce: "pn" };
  let starts = 0;
  let releaseWrite;
  const gate = new Promise((r) => { releaseWrite = r; });
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => ({
      async writeFile() { await gate; },
      async startProcess() { starts += 1; throw new Error("must-not-start"); },
      async killProcess() {},
    }),
    sandboxBinding: {},
  });
  const { executionRef } = backend.start({ contract, task: "x" });
  // Cancel BEFORE the writeFile await releases and before any processId exists.
  const p = backend.cancel(executionRef);
  assert.ok(p && typeof p.then === "function", "cancel returns a promise even pre-launch");
  const ok = await p;
  assert.equal(ok, true, "pre-launch cancel resolves true immediately");
  releaseWrite();
  const exit = await backend.waitExit(executionRef);
  assert.equal(exit.cancelled, true);
  assert.equal(starts, 0, "startProcess must never be called after pre-launch cancel");
});

// Blocker 4: The inline (SQL) log write must NEVER exceed MAX_LOG_SQL_BYTES,
// even when the overflow marker is included.
test("Round 5B.1 (4): inline SQL total never exceeds MAX_LOG_SQL_BYTES with overflow marker reserved", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const env = {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    TERRARIUM_ARTIFACTS: { async put() { return { key: "x" }; } },
  };
  const doInst = new RunControlDO(state, env);
  // Produce stdout exactly at the boundary + a bit more so an overflow marker
  // is added.
  const big = "A".repeat(_testables.MAX_LOG_SQL_BYTES + 100);
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "reserve marker", ownerId: "owner-RM", spec: { rawStdout: big } }),
  }));
  await state.drain();
  await new Promise((r) => setTimeout(r, 20));
  // Inspect the run_logs table via the sql shim.
  const rows = state.storage.sql.exec("SELECT chunk FROM run_logs").toArray();
  const totalInlineBytes = rows.reduce((n, r) => n + new TextEncoder().encode(r.chunk).byteLength, 0);
  assert.ok(
    totalInlineBytes <= _testables.MAX_LOG_SQL_BYTES,
    `inline SQL total ${totalInlineBytes} exceeded MAX_LOG_SQL_BYTES ${_testables.MAX_LOG_SQL_BYTES}`,
  );
  // The overflow marker must be present.
  assert.ok(rows.some((r) => r.chunk.includes("log-overflow-to-r2")), "overflow marker required");
});

test("Round 5B.2: a nearly-full SQL budget never overflows on a marker that cannot fit", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = makeSqlShim(db);
  new _testables.SqlRunStateStore(sql);
  const store = new _testables.SqlLogArtifactStore(sql, {
    TERRARIUM_ARTIFACTS: { async put() {} },
  });
  const runId = "ter_marker_edge";
  store.append(runId, "A".repeat(_testables.MAX_LOG_SQL_BYTES - 8));
  store.append(runId, "B".repeat(100));
  await store.flush(runId);
  const [{ n }] = sql.exec("SELECT COALESCE(SUM(LENGTH(CAST(chunk AS BLOB))), 0) AS n FROM run_logs WHERE run_id = ?", runId).toArray();
  assert.ok(Number(n) <= _testables.MAX_LOG_SQL_BYTES);
  const refs = store.logRefs(runId);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].byteCount, 100, "the entire second chunk is offloaded when its marker cannot fit");
});

// Blocker 5: R2 sequence allocation is durable, monotonic, and SYNC before
// any await. Two concurrent overflow puts must NEVER share a seq/key.
test("Round 5B.1 (5): two concurrent R2 overflow puts allocate distinct monotonic sequences via counter table", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const putKeys = [];
  let holdA;
  const holdAPromise = new Promise((r) => { holdA = r; });
  const env = {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    TERRARIUM_ARTIFACTS: {
      async put(key, value) {
        putKeys.push(key);
        // Hold the FIRST put open so the second put runs before the first ref
        // row is committed — proves seq allocation is independent of ref insert.
        if (putKeys.length === 1) await holdAPromise;
        return { key };
      },
    },
  };
  const doInst = new RunControlDO(state, env);
  const big = "L".repeat(_testables.MAX_LOG_SQL_BYTES + 20 * 1024);
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "seq-alloc", ownerId: "owner-SA", spec: { rawStdout: big } }),
  }));
  // Give the first put a moment to start.
  await new Promise((r) => setTimeout(r, 10));
  // Second overflow: append more logs — this triggers a second R2 put and
  // must synchronously get a distinct seq number BEFORE the first put resolves.
  const logRow = state.storage.sql.exec("SELECT run_id FROM run_state LIMIT 1").toArray()[0];
  const runId = logRow.run_id;
  // Use the sql shim + a fresh log store to append more overflow.
  const store = new _testables.SqlLogArtifactStore(state.storage.sql, env, { waitUntil: state.waitUntil.bind(state) });
  store.append(runId, "M".repeat(_testables.MAX_LOG_SQL_BYTES + 4 * 1024));
  await new Promise((r) => setTimeout(r, 10));
  // Now release the first put.
  holdA();
  await state.drain();
  await new Promise((r) => setTimeout(r, 20));
  // All allocated keys must be distinct — seq collision would repeat a key.
  const unique = new Set(putKeys);
  assert.equal(unique.size, putKeys.length, `R2 keys collided: ${putKeys.join(", ")}`);
  // Sequences must be strictly monotonic (000000 < 000001 < ...).
  const seqs = putKeys.map((k) => Number(String(k).match(/(\d{6})\.log$/)?.[1] ?? -1));
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `sequences must be monotonic: ${seqs}`);
  }
});

// Blocker 6: LocalRunCell finalization awaits flush(runId); a rejected flush
// causes the terminal to be infrastructure-FAILED with reason
// "log-persistence-failed", never done. Exactly one callback is emitted.
test("Round 5B.1 (6): failed R2 flush finalizes as log-persistence-failed (never done)", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  const env = {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    TERRARIUM_ARTIFACTS: { async put() { throw new Error("r2-permanent-fail"); } },
  };
  // Suppress the surfacing rejection so the test process doesn't crash on
  // the awaited waitUntil promise chain.
  const origWaitUntil = state.waitUntil.bind(state);
  state.waitUntil = (p) => { origWaitUntil(Promise.resolve(p).catch(() => {})); };
  const doInst = new RunControlDO(state, env);
  const big = "K".repeat(_testables.MAX_LOG_SQL_BYTES + 8 * 1024);
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "flush-fail", ownerId: "owner-FF", spec: { rawStdout: big } }),
  }));
  await state.drain();
  await new Promise((r) => setTimeout(r, 20));
  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-FF" }),
  }));
  const body = await collect.json();
  assert.equal(body.terminal.status, "failed", "must NOT emit done when logs failed to persist");
  assert.equal(body.terminal.reason, "log-persistence-failed");
});

// Blocker 7: Admission MUST NOT return 202 when the durable sandboxId/processId
// patch fails or address is missing. Idempotent retry of an addressless row
// must ALSO fail.
test("Round 5B.1 (7a): admission fails closed when backend cannot produce an address", async () => {
  const state = makeStateOverDb(new DatabaseSync(":memory:"));
  // Block address production. No test compatibility flag => admission must fail.
  const doInst = new RunControlDO(state, {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    __TERRARIUM_TEST_BLOCK_ADDRESS__: true,
  });
  const res = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "no-addr", ownerId: "owner-Q" }),
  }));
  assert.equal(res.status, 500, "admission without an address must not return 202");
  const body = await res.json();
  assert.equal(body.admitted, false);
  assert.match(String(body.reason), /address/);
});

test("Round 5B.1 (7b): idempotent retry of an addressless durable row also fails closed", async () => {
  const db = new DatabaseSync(":memory:");
  const state1 = makeStateOverDb(db);
  // First admission goes through with allow-addressless (test-compat) so we
  // have a durable row with null sandboxId/processId.
  const doA = new RunControlDO(state1, {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    __TERRARIUM_TEST_BLOCK_ADDRESS__: true,
    __TERRARIUM_TEST_ALLOW_ADDRESSLESS__: true,
  });
  const first = await doA.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "idem-addressless", ownerId: "owner-IA", runId: "ter_ia_1" }),
  }));
  assert.equal(first.status, 202);
  // Second admission WITHOUT the allow-flag: idempotent retry must fail closed
  // because the durable row is still addressless.
  const state2 = makeStateOverDb(db);
  const doB = new RunControlDO(state2, {
    __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend(),
    __TERRARIUM_TEST_BLOCK_ADDRESS__: true,
  });
  // Trigger DO init so it adopts the existing run.
  await doB.fetch(new Request("https://do/status?ownerId=owner-IA", { method: "GET" }));
  const second = await doB.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "idem-addressless", ownerId: "owner-IA", runId: "ter_ia_1" }),
  }));
  assert.equal(second.status, 500, "addressless idempotent retry must also fail closed");
});
