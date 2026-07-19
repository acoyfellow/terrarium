// Cloud Terrarium production RunControlDO + /api/runs surface — focused tests.
//
// These tests drive the Durable Object class and the /api/runs router directly.
// A test backend implements the same run-cell backend port as the real Sandbox
// backend (start/waitExit/logChunks/cancel/timeout), so we cover the production
// wiring end-to-end WITHOUT booting a container. The SandboxContainerBackendReal
// module is exercised for its shape/conformance separately.
//
// Covered contracts:
//   1. POST /api/runs requires bearer auth (fail-closed).
//   2. POST /api/runs admits, returns runId + contract; DO persists state.
//   3. GET /api/runs/:id/status is owner-scoped (cross-owner denied).
//   4. GET /api/runs/:id/logs returns durable bounded logs after finalize.
//   5. POST /api/runs/:id/cancel records cancel intent, drives terminal.
//   6. Verified TERRARIUM_RESULT is the ONLY thing that establishes success.
//   7. Missing/mismatched receipt on clean exit => inconclusive.
//   8. Terminal callback event id is stable and single-delivery via journal.
//   9. Bounded task size fails closed.
//  10. SandboxContainerBackendReal conforms to backend adapter port.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { RunControlDO, _testables } from "../src/cloud/run-control-do.js";
import { handleApiRuns } from "../src/cloud/api-runs.js";
import {
  DetachedProcessBackend,
} from "../src/cloud/local-run-cell.js";
import { SandboxContainerBackendReal } from "../src/cloud/sandbox-backend.js";
import { BACKEND_ADAPTER_METHODS, assertBackendAdapter } from "../src/cloud/backend-adapter.js";
import { PrincipalBudgetDO } from "../src/cloud/principal-budget-do.js";

// --- SQL shim identical in shape to the pulse-do test shim ---
function makeSqlShim() {
  const db = new DatabaseSync(":memory:");
  return {
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

/** Storage stub for the DO. `waitUntil` runs the promise synchronously enough
 *  for the terminal to land before we peek — good enough for these tests. */
function makeState() {
  const sql = makeSqlShim();
  const pending = [];
  return {
    storage: { sql },
    waitUntil(p) { pending.push(Promise.resolve(p)); },
    async drain() { await Promise.allSettled(pending.splice(0)); },
  };
}

/** Namespace mock that maps `idFromName -> get` onto one DO per runId. */
function makeRunNamespace(ledger) {
  const instances = new Map();
  return {
    idFromName(name) { return { toString: () => `id_${name}`, __name: name }; },
    get(id) {
      const name = id.__name;
      if (!instances.has(name)) {
        const state = makeState();
        const backend = new DetachedProcessBackend();
        const env = { __TERRARIUM_TEST_BACKEND__: backend, ...(ledger ? { TERRARIUM_LEDGER: ledger } : {}) };
        const doInstance = new RunControlDO(state, env);
        instances.set(name, { doInstance, state, backend });
      }
      const { doInstance, state } = instances.get(name);
      return {
        async fetch(url, init) {
          const req = new Request(url, init);
          const res = await doInstance.fetch(req);
          await state.drain();
          return res;
        },
      };
    },
    _instances: instances,
  };
}

/** Namespace mock for PrincipalBudgetDO, mapping principalId -> single DO. */
function makePrincipalBudgetNamespace() {
  const instances = new Map();
  return {
    idFromName(name) { return { toString: () => `id_${name}`, __name: name }; },
    get(id) {
      const name = id.__name;
      if (!instances.has(name)) {
        const state = makeState();
        instances.set(name, new PrincipalBudgetDO(state, {}));
      }
      const doInstance = instances.get(name);
      return {
        async fetch(url, init) {
          const req = new Request(url, init);
          return await doInstance.fetch(req);
        },
      };
    },
  };
}

function makeEnv({
  principalId = "principal-test",
  currentToken = "test-token-current",
  previousToken,
  ledger,
} = {}) {
  const env = {
    TERRARIUM_PRINCIPAL_ID: principalId,
    TERRARIUM_CONTROL_TOKEN_CURRENT: currentToken,
    TERRARIUM_RUN: makeRunNamespace(ledger),
    TERRARIUM_PRINCIPAL_BUDGET: makePrincipalBudgetNamespace(),
    ...(ledger ? { TERRARIUM_LEDGER: ledger } : {}),
  };
  if (previousToken) env.TERRARIUM_CONTROL_TOKEN_PREVIOUS = previousToken;
  return env;
}

let __idemCounter = 0;
function nextIdempotencyKey() { __idemCounter += 1; return `idem-key-${__idemCounter}-${Date.now().toString(36)}`; }

function bearerRequest(url, { method = "GET", token = "test-token-current", body, idempotencyKey } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  // Attach Idempotency-Key on POST /api/runs by default so the many admit
  // tests below do not each need to supply one manually.
  if (idempotencyKey !== undefined) {
    headers["idempotency-key"] = idempotencyKey;
  } else if (method === "POST" && /\/api\/runs$/.test(url)) {
    headers["idempotency-key"] = nextIdempotencyKey();
  }
  return new Request(url, init);
}

// ---------------- backend port conformance ----------------

test("SandboxContainerBackendReal conforms to backend adapter port", () => {
  // Instantiate with a stub getSandbox and any truthy binding.
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => ({ exec: async () => ({ exitCode: 0 }) }),
    sandboxBinding: { idFromName: () => ({}), get: () => ({}) },
  });
  assertBackendAdapter(backend, "SandboxContainerBackendReal");
  for (const m of BACKEND_ADAPTER_METHODS) {
    assert.equal(typeof backend[m], "function", `missing method: ${m}`);
  }
});

test("SandboxContainerBackendReal uses deterministic durable process address and recovers logs", async () => {
  // Fake sandbox using the 0.12 API surface: startProcess(command, options),
  // waitForExit(), and getLogs().
  const contract = { runId: "ter_test_a1", taskFingerprint: "fp".repeat(12), nonce: "n1" };
  const receiptLine = `TERRARIUM_RESULT=${JSON.stringify({ runId: contract.runId, taskFingerprint: contract.taskFingerprint, nonce: contract.nonce, summary: "ok" })}\n`;
  const writes = new Map();
  const fakeSandbox = {
    async writeFile(path, content) { writes.set(path, content); return { success: true }; },
    async startProcess(command, options) {
      assert.equal(typeof command, "string", "command must be a single string");
      assert.ok(!command.includes("do something"), "task text MUST NOT be interpolated into the shell command");
      assert.equal(options.processId, `terrarium-${contract.runId}`);
      assert.equal(options.autoCleanup, false);
      return {
        id: options.processId,
        pid: 42,
        command,
        status: "completed",
        startTime: new Date(),
        async kill() {},
        async getStatus() { return "completed"; },
        async getLogs() { return { stdout: `step 1\n${receiptLine}`, stderr: "" }; },
        async waitForExit() { return { exitCode: 0 }; },
      };
    },
  };
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => fakeSandbox,
    sandboxBinding: { idFromName: () => ({}), get: () => ({}) },
  });
  const { executionRef, processId } = backend.start({ contract, task: "do something" });
  assert.equal(processId, `terrarium-${contract.runId}`);
  assert.equal(backend.describe(executionRef).processId, processId);
  const exit = await backend.waitExit(executionRef);
  assert.equal(exit.exitCode, 0);
  const joined = backend.logChunks(executionRef).join("");
  assert.ok(joined.includes("step 1"));
  assert.ok(joined.includes("TERRARIUM_RESULT="));
  // The bounded runner receives the task via writeFile, never as an argv.
  assert.ok(writes.has("/workspace/terrarium-task.txt"));
  assert.equal(writes.get("/workspace/terrarium-task.txt"), "do something");
});

test("SandboxContainerBackendReal cancel/timeout settle and record intent", async () => {
  const contract = { runId: "ter_test_a2", taskFingerprint: "fp".repeat(12), nonce: "n2" };
  const killed = [];
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => ({
      async writeFile() { return { success: true }; },
      async startProcess(_cmd, _opts) {
        return {
          id: _opts.processId, pid: 1, command: _cmd, status: "running", startTime: new Date(),
          async kill() {},
          async getStatus() { return "running"; },
          async getLogs() { return { stdout: "", stderr: "" }; },
          async waitForExit() { return new Promise(() => {}); },
        };
      },
      async killProcess(id, signal) { killed.push({ id, signal }); },
      async destroy() {},
    }),
    sandboxBinding: { idFromName: () => ({}), get: () => ({}) },
  });
  const { executionRef } = backend.start({ contract, task: "long" });
  // Give the async #launch a microtask to record processId before cancel.
  await new Promise((r) => setTimeout(r, 5));
  backend.cancel(executionRef);
  const exit = await backend.waitExit(executionRef);
  assert.equal(exit.cancelled, true);
  assert.equal(exit.signal, "SIGTERM");

  const contract2 = { runId: "ter_test_a3", taskFingerprint: "fp".repeat(12), nonce: "n3" };
  const { executionRef: ref2 } = backend.start({ contract: contract2, task: "long" });
  await new Promise((r) => setTimeout(r, 5));
  backend.timeout(ref2);
  const exit2 = await backend.waitExit(ref2);
  assert.equal(exit2.timedOut, true);
  assert.equal(exit2.signal, "SIGKILL");
  assert.deepEqual(killed, [
    { id: `terrarium-${contract.runId}`, signal: "SIGTERM" },
    { id: `terrarium-${contract2.runId}`, signal: "SIGKILL" },
  ]);
});

test("SandboxContainerBackendReal cancel before task delivery prevents process start", async () => {
  const contract = { runId: "ter_cancel_before_start", taskFingerprint: "ab".repeat(12), nonce: "n-cancel" };
  let releaseWrite;
  let starts = 0;
  const firstWrite = new Promise((resolve) => { releaseWrite = resolve; });
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => ({
      async writeFile() { await firstWrite; },
      async startProcess() { starts += 1; throw new Error("must not start"); },
      async killProcess() {},
    }),
    sandboxBinding: {},
  });
  const { executionRef } = backend.start({ contract, task: "data" });
  backend.cancel(executionRef);
  releaseWrite();
  const exit = await backend.waitExit(executionRef);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(exit.cancelled, true);
  assert.equal(starts, 0);
});

test("SandboxContainerBackendReal retries a raced startProcess kill before settling", async () => {
  const contract = { runId: "ter_cancel_start_race", taskFingerprint: "bc".repeat(12), nonce: "n-race" };
  let releaseStart;
  let markStartEntered;
  let killCalls = 0;
  const startEntered = new Promise((resolve) => { markStartEntered = resolve; });
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const fakeSandbox = {
    async writeFile() {},
    async startProcess(_command, options) {
      markStartEntered();
      await startGate;
      return {
        id: options.processId,
        async waitForExit() { throw new Error("intent race must not enter waitForExit"); },
        async getLogs() { return { stdout: "", stderr: "" }; },
      };
    },
    async killProcess() {
      killCalls += 1;
      if (killCalls === 1) throw new Error("process not visible yet");
    },
  };
  const backend = new SandboxContainerBackendReal({ getSandbox: async () => fakeSandbox, sandboxBinding: {} });
  const { executionRef } = backend.start({ contract, task: "data" });
  await startEntered;
  assert.equal(await backend.cancel(executionRef), false, "first in-flight kill is not confirmation");
  const beforeRelease = await Promise.race([
    backend.waitExit(executionRef).then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  assert.equal(beforeRelease, "pending", "failed raced kill must not settle waitExit");
  releaseStart();
  const exit = await backend.waitExit(executionRef);
  assert.equal(exit.cancelled, true);
  assert.equal(killCalls, 2, "returned process is killed again at its deterministic address");
});

test("SandboxContainerBackendReal keeps UTF-8 byte-bounded head and late receipt tail", async () => {
  const contract = { runId: "ter_utf8_tail", taskFingerprint: "cd".repeat(12), nonce: "n-tail" };
  const receipt = `TERRARIUM_RESULT=${JSON.stringify({ ...contract, summary: "late receipt" })}\n`;
  const stdout = `${"😀".repeat(60_000)}\n${receipt}`;
  const backend = new SandboxContainerBackendReal({
    getSandbox: async () => ({
      async writeFile() {},
      async startProcess(_command, options) {
        return {
          id: options.processId,
          async waitForExit() { return { exitCode: 0 }; },
          async getLogs() { return { stdout, stderr: "" }; },
        };
      },
    }),
    sandboxBinding: {},
  });
  const { executionRef } = backend.start({ contract, task: "data" });
  const exit = await backend.waitExit(executionRef);
  const joined = backend.logChunks(executionRef).join("");
  const meta = backend.describe(executionRef);
  assert.equal(exit.exitCode, 0);
  assert.ok(meta.byteCount > 128 * 1024);
  assert.ok(meta.truncatedBytes > 0);
  assert.ok(Buffer.byteLength(joined, "utf8") < 129 * 1024);
  assert.ok(joined.includes("[terrarium:log-truncated"));
  assert.ok(joined.includes(receipt.trim()), "late authoritative receipt must survive");
});

test("SandboxContainerBackendReal reattaches by durable processId after backend recreation", async () => {
  const contract = { runId: "ter_restart_process", taskFingerprint: "ef".repeat(12), nonce: "n-restart" };
  const processId = `terrarium-${contract.runId}`;
  const killed = [];
  const fakeSandbox = {
    async getProcess(id) {
      assert.equal(id, processId);
      return {
        id,
        exitCode: 0,
        async getStatus() { return "completed"; },
        async getLogs() { return { stdout: "recovered\n", stderr: "" }; },
      };
    },
    async killProcess(id, signal) { killed.push({ id, signal }); },
    async getProcessLogs() { return { stdout: "recovered\n", stderr: "" }; },
  };
  const backend = new SandboxContainerBackendReal({ getSandbox: async () => fakeSandbox, sandboxBinding: {} });
  backend.reattach({ executionRef: "persisted-ref", sandboxId: `run-${contract.runId}`, processId, contract, deadlineMs: 1000 });
  const exit = await backend.waitExit("persisted-ref");
  assert.equal(exit.exitCode, 0);
  assert.ok(backend.logChunks("persisted-ref").join("").includes("recovered"));
  assert.equal(backend.describe("persisted-ref").processId, processId);
  assert.deepEqual(killed, []);
});

// ---------------- /api/runs auth + happy path ----------------

test("POST /api/runs requires bearer auth (fail-closed)", async () => {
  const env = makeEnv();
  const res = await handleApiRuns(new Request("https://x/api/runs", { method: "POST" }), env);
  assert.equal(res.status, 401);
});

test("GET /api/runs requires bearer auth (fail-closed)", async () => {
  const env = makeEnv({ ledger: makeIndexKV() });
  const res = await handleApiRuns(new Request("https://x/api/runs", { method: "GET" }), env);
  assert.equal(res.status, 401);
});

test("GET /api/runs lists the caller's own runs with channel rollup", async () => {
  const ledger = makeIndexKV();
  const env = makeEnv({ ledger });
  // Admit two runs on the same channel via the real API path.
  for (let i = 0; i < 2; i++) {
    const admit = await handleApiRuns(
      bearerRequest("https://x/api/runs", { method: "POST", body: { task: `t${i}`, spec: { channel: "loop-A" } } }),
      env,
    );
    assert.equal(admit.status, 202);
  }
  const res = await handleApiRuns(bearerRequest("https://x/api/runs", { method: "GET" }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.runs.length, 2, "both admitted runs are indexed and listed");
  assert.ok(body.channels["loop-A"], "channel rollup present");
  assert.equal(body.channels["loop-A"].total, 2);
  for (const r of body.runs) assert.equal(r.ownerId, "principal-test");
});

test("GET /api/runs is owner-scoped: principal B never sees principal A's runs", async () => {
  const ledger = makeIndexKV();
  const envA = makeEnv({ principalId: "principal-A", currentToken: "tok-A", ledger });
  const envB = makeEnv({ principalId: "principal-B", currentToken: "tok-B", ledger });
  await handleApiRuns(
    bearerRequest("https://x/api/runs", { method: "POST", token: "tok-A", body: { task: "a-run", spec: { channel: "c" } } }),
    envA,
  );
  const resB = await handleApiRuns(bearerRequest("https://x/api/runs", { method: "GET", token: "tok-B" }), envB);
  assert.equal(resB.status, 200);
  const bodyB = await resB.json();
  assert.equal(bodyB.runs.length, 0, "cross-principal runs are invisible");
});

test("GET /api/runs filters by channel and status", async () => {
  const ledger = makeIndexKV();
  const env = makeEnv({ ledger });
  await handleApiRuns(bearerRequest("https://x/api/runs", { method: "POST", body: { task: "x", spec: { channel: "keep" } } }), env);
  await handleApiRuns(bearerRequest("https://x/api/runs", { method: "POST", body: { task: "y", spec: { channel: "drop" } } }), env);
  const res = await handleApiRuns(bearerRequest("https://x/api/runs?channel=keep", { method: "GET" }), env);
  const body = await res.json();
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].channel, "keep");
});

test("GET /api/runs is fail-soft when the index binding is absent", async () => {
  const env = makeEnv(); // no ledger
  const res = await handleApiRuns(bearerRequest("https://x/api/runs", { method: "GET" }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.indexUnavailable, true);
  assert.deepEqual(body.runs, []);
});

test("POST /api/runs admits and returns 202 + runId + contract", async () => {
  const env = makeEnv();
  const req = bearerRequest("https://x/api/runs", { method: "POST", body: { task: "summarize" } });
  const res = await handleApiRuns(req, env);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.admitted, true);
  assert.match(body.runId, /^ter_[a-z0-9_]+$/);
  assert.equal(body.contract.runId, body.runId);
  assert.equal(typeof body.contract.taskFingerprint, "string");
  assert.equal(typeof body.contract.nonce, "string");
});

test("POST /api/runs rejects oversized task", async () => {
  const env = makeEnv();
  const big = "x".repeat(80 * 1024);
  const req = bearerRequest("https://x/api/runs", { method: "POST", body: { task: big } });
  const res = await handleApiRuns(req, env);
  assert.equal(res.status, 413);
});

test("POST /api/runs rejects missing task", async () => {
  const env = makeEnv();
  const req = bearerRequest("https://x/api/runs", { method: "POST", body: {} });
  const res = await handleApiRuns(req, env);
  assert.equal(res.status, 400);
});

test("GET /api/runs/:id/status returns owner-scoped run state", async () => {
  const env = makeEnv();
  const admit = await handleApiRuns(
    bearerRequest("https://x/api/runs", { method: "POST", body: { task: "hello" } }),
    env,
  );
  const { runId } = await admit.json();
  const status = await handleApiRuns(
    bearerRequest(`https://x/api/runs/${runId}/status`, { method: "GET" }),
    env,
  );
  assert.equal(status.status, 200);
  const stBody = await status.json();
  assert.equal(stBody.ok, true);
  assert.equal(stBody.status.runId, runId);
  // The detached test backend finalizes eagerly; status will be done.
  assert.ok(["running", "done"].includes(stBody.status.status));
});

test("cross-owner status read normalizes to 404 (Round 5C1)", async () => {
  // With principal-auth the token no longer derives ownerId. To exercise
  // cross-principal isolation we admit under principal-A and then re-run the
  // read against a wholly independent env that authenticates as principal-B
  // reusing the SAME RunControl namespace. principal-B cannot see A's run;
  // response is normalized to 404 (never 403), so probers cannot enumerate.
  const runNs = makeRunNamespace();
  const envA = {
    TERRARIUM_PRINCIPAL_ID: "principal-A",
    TERRARIUM_CONTROL_TOKEN_CURRENT: "token-A",
    TERRARIUM_RUN: runNs,
    TERRARIUM_PRINCIPAL_BUDGET: makePrincipalBudgetNamespace(),
  };
  const envB = {
    TERRARIUM_PRINCIPAL_ID: "principal-B",
    TERRARIUM_CONTROL_TOKEN_CURRENT: "token-B",
    TERRARIUM_RUN: runNs, // shared namespace
    TERRARIUM_PRINCIPAL_BUDGET: makePrincipalBudgetNamespace(),
  };
  const admit = await handleApiRuns(
    new Request("https://x/api/runs", {
      method: "POST",
      headers: { authorization: "Bearer token-A", "content-type": "application/json", "idempotency-key": nextIdempotencyKey() },
      body: JSON.stringify({ task: "priv" }),
    }),
    envA,
  );
  assert.equal(admit.status, 202);
  const { runId } = await admit.json();
  const status = await handleApiRuns(
    new Request(`https://x/api/runs/${runId}/status`, {
      method: "GET",
      headers: { authorization: "Bearer token-B" },
    }),
    envB,
  );
  assert.equal(status.status, 404, "cross-principal read must normalize to 404");
});

test("GET /api/runs/:id/logs returns durable logs after finalize", async () => {
  const env = makeEnv();
  const admit = await handleApiRuns(
    bearerRequest("https://x/api/runs", { method: "POST", body: { task: "logs test" } }),
    env,
  );
  const { runId } = await admit.json();
  const logs = await handleApiRuns(
    bearerRequest(`https://x/api/runs/${runId}/logs`, { method: "GET" }),
    env,
  );
  assert.equal(logs.status, 200);
  const body = await logs.json();
  assert.equal(body.ok, true);
  assert.equal(body.runId, runId);
  // Detached backend emits a receipt marker by default.
  assert.ok(body.logs.includes("TERRARIUM_RESULT="));
});

test("POST /api/runs/:id/cancel records cancel intent (owner-scoped)", async () => {
  const env = makeEnv();
  const admit = await handleApiRuns(
    bearerRequest("https://x/api/runs", { method: "POST", body: { task: "cancellable" } }),
    env,
  );
  const { runId } = await admit.json();
  const cancel = await handleApiRuns(
    bearerRequest(`https://x/api/runs/${runId}/cancel`, { method: "POST", body: {} }),
    env,
  );
  assert.equal(cancel.status, 200);
  const body = await cancel.json();
  assert.equal(body.ok, true);
  assert.equal(body.cancelled, true);
});

test("cancel by a different principal is normalized to 404 (Round 5C1)", async () => {
  const runNs = makeRunNamespace();
  const envA = {
    TERRARIUM_PRINCIPAL_ID: "principal-A",
    TERRARIUM_CONTROL_TOKEN_CURRENT: "token-A",
    TERRARIUM_RUN: runNs,
    TERRARIUM_PRINCIPAL_BUDGET: makePrincipalBudgetNamespace(),
  };
  const envB = {
    TERRARIUM_PRINCIPAL_ID: "principal-B",
    TERRARIUM_CONTROL_TOKEN_CURRENT: "token-B",
    TERRARIUM_RUN: runNs,
    TERRARIUM_PRINCIPAL_BUDGET: makePrincipalBudgetNamespace(),
  };
  const admit = await handleApiRuns(
    new Request("https://x/api/runs", {
      method: "POST",
      headers: { authorization: "Bearer token-A", "content-type": "application/json", "idempotency-key": nextIdempotencyKey() },
      body: JSON.stringify({ task: "no cross-cancel" }),
    }),
    envA,
  );
  const { runId } = await admit.json();
  const cancel = await handleApiRuns(
    new Request(`https://x/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer token-B", "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    envB,
  );
  assert.equal(cancel.status, 404);
});

test("run id validation rejects malformed ids", async () => {
  const env = makeEnv();
  const res = await handleApiRuns(
    bearerRequest("https://x/api/runs/not-a-valid-id/status", { method: "GET" }),
    env,
  );
  assert.equal(res.status, 400);
});

// ---------------- DO-level receipt authority ----------------

test("DO admits and finalizes with verified receipt => done", async () => {
  // Reach into the DO directly (skip API) to prove the classification path.
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const env = { __TERRARIUM_TEST_BACKEND__: backend };
  const doInst = new RunControlDO(state, env);

  const res = await doInst.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "verified path", ownerId: "owner-A" }),
  }));
  assert.equal(res.status, 202);
  const body = await res.json();
  await state.drain();

  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }));
  const collectBody = await collect.json();
  assert.equal(collectBody.ok, true);
  assert.equal(collectBody.terminal.status, "done");
  assert.equal(collectBody.terminal.taskContractStatus, "verified");
});

test("DO finalization requires backend; sandbox binding missing => 500", async () => {
  const state = makeState();
  const env = {}; // no TERRARIUM_SANDBOX, no __TERRARIUM_TEST_BACKEND__
  const doInst = new RunControlDO(state, env);
  const res = await doInst.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "no backend", ownerId: "owner-A" }),
  }));
  assert.equal(res.status, 500);
});

test("DO missing receipt on clean exit => inconclusive (exit alone is not success)", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const env = { __TERRARIUM_TEST_BACKEND__: backend };
  const doInst = new RunControlDO(state, env);

  await doInst.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "no receipt", ownerId: "owner-A", spec: { emitReceipt: false } }),
  }));
  await state.drain();
  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }));
  const body = await collect.json();
  assert.equal(body.terminal.status, "inconclusive");
  assert.equal(body.terminal.taskContractStatus, "missing");
});

test("DO mismatched nonce on clean exit => inconclusive", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const env = { __TERRARIUM_TEST_BACKEND__: backend };
  const doInst = new RunControlDO(state, env);

  await doInst.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "wrong nonce", ownerId: "owner-A", spec: { receiptOverride: { nonce: "wrong" } } }),
  }));
  await state.drain();
  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }));
  const body = await collect.json();
  assert.equal(body.terminal.status, "inconclusive");
  assert.equal(body.terminal.taskContractStatus, "mismatch");
});

test("DO cancel intent wins over a raced verified receipt", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const env = { __TERRARIUM_TEST_BACKEND__: backend };
  const doInst = new RunControlDO(state, env);

  await doInst.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: "raced cancel",
      ownerId: "owner-A",
      spec: { blocks: true, receiptDespiteKill: true, partialStdout: "half\n" },
    }),
  }));
  // Do NOT drain — the admit run has not finalized yet because the backend blocks.
  await doInst.fetch(new Request("https://do/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }));
  await state.drain();
  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }));
  const body = await collect.json();
  assert.equal(body.terminal.status, "cancelled");
  assert.equal(body.terminal.reason, "cancel-requested");
});

test("DO idempotent collect: two collects yield the same terminal", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const env = { __TERRARIUM_TEST_BACKEND__: backend };
  const doInst = new RunControlDO(state, env);

  await doInst.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "idempotent", ownerId: "owner-A" }),
  }));
  await state.drain();
  const a = await (await doInst.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }))).json();
  const b = await (await doInst.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }))).json();
  assert.equal(a.terminal.status, b.terminal.status);
  assert.equal(a.terminal.status, "done");
});

test("DO idempotent cancel of an already-terminal run: no 500, returns alreadyTerminal (issue #18)", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const env = { __TERRARIUM_TEST_BACKEND__: backend };
  const doInst = new RunControlDO(state, env);

  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "finishes then cancelled", ownerId: "owner-A" }),
  }));
  await state.drain(); // drive to terminal (done)
  const collect = await (await doInst.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }))).json();
  assert.equal(collect.terminal.status, "done");
  // Simulate DO restart / handle loss: a FRESH RunControlDO over the SAME durable
  // state but with a FRESH backend (empty in-memory execution map), so the
  // terminal run's execution is gone — the exact 'unknown executionRef'
  // condition from issue #18 that produced HTTP 500.
  const restartedEnv = { __TERRARIUM_TEST_BACKEND__: new DetachedProcessBackend() };
  const restarted = new RunControlDO(state, restartedEnv);
  const res = await restarted.fetch(new Request("https://do/cancel", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-A" }),
  }));
  assert.equal(res.status, 200, "cancel of an already-terminal run after restart must be 200, not 500");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.alreadyTerminal, true);
});

test("Round 5B.1: alarm cannot finalize a run whose process still reports running after a failed kill", async () => {
  // A backend whose poll() only reports terminal after cancel/timeout is
  // actually acknowledged by killProcess. Model a first-kill failure by
  // rejecting the first kill call.
  class RetryableKillBackend {
    #rec = null;
    #killCalls = 0;
    describe() { return { sandboxId: "sbx-x", processId: "proc-x" }; }
    start(spec) {
      const executionRef = "exec-r";
      this.#rec = { spec, exit: null, waitResolvers: [], settled: false };
      return { executionRef, pid: 1 };
    }
    waitExit() {
      if (this.#rec.exit) return Promise.resolve(this.#rec.exit);
      return new Promise((r) => this.#rec.waitResolvers.push(r));
    }
    logChunks() { return ["partial\n"]; }
    async poll() {
      // Only terminal after a successful kill call (>=2 kill attempts).
      if (this.#killCalls >= 2 && !this.#rec.exit) {
        this.#rec.exit = { exitCode: 143, signal: "SIGTERM", cancelled: true };
        for (const r of this.#rec.waitResolvers) r(this.#rec.exit);
        this.#rec.waitResolvers = [];
      }
      return this.#rec.exit ? { terminal: true, ...this.#rec.exit } : { terminal: false, status: "running" };
    }
    cancel() {
      this.#killCalls += 1;
      if (this.#killCalls === 1) return Promise.resolve(false); // first kill fails
      return Promise.resolve(true);
    }
    timeout() { return this.cancel(); }
    get killCalls() { return this.#killCalls; }
  }
  const state = makeState();
  const backend = new RetryableKillBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });
  const admitRes = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "retry-kill", ownerId: "owner-RK", spec: { deadlineMs: 60 * 60 * 1000 } }),
  }));
  assert.equal(admitRes.status, 202);
  // First cancel: kill fails. Do NOT drain — the admit's driveToTerminal is
  // blocked on the never-exiting child, which is exactly the scenario we test.
  await doInst.fetch(new Request("https://do/cancel", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-RK" }),
  }));
  // Run must NOT be finalized yet: kill failed once and process still runs.
  const rows1 = state.storage.sql.exec("SELECT finalized FROM run_state").toArray();
  assert.equal(Number(rows1[0]?.finalized || 0), 0, "must not finalize while process still reports running");
  assert.equal(backend.killCalls, 1, "exactly one kill attempted so far");
  // Fire alarm: poll returns non-terminal pre-deadline => must re-arm and
  // return without collecting; still no finalization.
  const alarmRaced = await Promise.race([
    doInst.alarm().then(() => "done"),
    new Promise((r) => setTimeout(() => r("hung"), 500)),
  ]);
  assert.equal(alarmRaced, "done", "alarm must not hang while process runs");
  const rows2 = state.storage.sql.exec("SELECT finalized FROM run_state").toArray();
  assert.equal(Number(rows2[0]?.finalized || 0), 0, "pre-deadline alarm must not finalize while running");
});

test("at-deadline kill retries until acknowledged and emits one terminal callback", async () => {
  class DeadlineKillBackend {
    #record; killCalls = 0;
    describe() { return { sandboxId: "sbx-deadline", processId: "proc-deadline" }; }
    start(spec) { this.#record = { spec, exit: null, waiters: [] }; return { executionRef: "exec-deadline", pid: 2 }; }
    waitExit() {
      if (this.#record.exit) return Promise.resolve(this.#record.exit);
      return new Promise((resolve) => this.#record.waiters.push(resolve));
    }
    logChunks() { return ["partial\n"]; }
    timeout() { this.killCalls += 1; return Promise.resolve(this.killCalls >= 2); }
    cancel() { return Promise.resolve(false); }
    async poll() {
      if (this.killCalls >= 2 && !this.#record.exit) {
        this.#record.exit = { exitCode: 124, signal: "SIGKILL", timedOut: true };
        for (const resolve of this.#record.waiters) resolve(this.#record.exit);
      }
      return this.#record.exit ? { terminal: true, ...this.#record.exit } : { terminal: false, status: "running" };
    }
  }
  const callbacks = new Map();
  let callbackAttempts = 0;
  const pulse = {
    idFromName() { return {}; },
    get() {
      return { async fetch(_url, init) {
        callbackAttempts += 1;
        const event = JSON.parse(init.body).args.event;
        callbacks.set(event.eventId, event); // mirrors Pulse journal dedup
        return new Response("ok");
      } };
    },
  };
  const state = makeState();
  const backend = new DeadlineKillBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend, PULSE_ROUTER: pulse });
  const admitted = await (await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "deadline retry", ownerId: "owner-deadline", spec: { deadlineMs: 60 * 60 * 1000 } }),
  }))).json();
  state.storage.sql.exec("UPDATE run_state SET deadline_at = ? WHERE run_id = ?", Date.now() - 1, admitted.runId);

  await doInst.alarm();
  let row = state.storage.sql.exec("SELECT finalized, intent, terminal_event FROM run_state WHERE run_id = ?", admitted.runId).toArray()[0];
  assert.equal(backend.killCalls, 1);
  assert.equal(Number(row.finalized), 0, "unacknowledged kill cannot finalize");
  assert.equal(row.intent, "timeout");
  assert.equal(row.terminal_event, null);

  await doInst.alarm();
  await state.drain();
  row = state.storage.sql.exec("SELECT finalized, terminal, terminal_event FROM run_state WHERE run_id = ?", admitted.runId).toArray()[0];
  assert.equal(backend.killCalls, 2);
  assert.equal(Number(row.finalized), 1);
  const terminal = JSON.parse(row.terminal);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.reason, "deadline-reached");
  const event = JSON.parse(row.terminal_event);
  assert.equal(event.eventId, `evt_${admitted.runId}_terminal`);
  assert.equal(callbacks.size, 1);
  assert.equal(callbacks.get(event.eventId).eventId, event.eventId);
  const attemptsAfterCommit = callbackAttempts;

  await doInst.alarm();
  await state.drain();
  assert.equal(callbacks.size, 1, "stable eventId yields one durable Pulse journal event");
  assert.equal(callbackAttempts, attemptsAfterCommit, "post-commit alarm does not retry delivery");
});

test("DO retrieves verified R2 overflow bytes without mutating terminal state", async () => {
  const state = makeState();
  const objects = new Map();
  const artifacts = {
    async put(key, value) { objects.set(key, new Uint8Array(value)); },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { async arrayBuffer() { return bytes.slice().buffer; } } : null;
    },
  };
  const backend = new DetachedProcessBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend, TERRARIUM_ARTIFACTS: artifacts });
  const admitted = await (await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "r2 retrieval", ownerId: "owner-R2", spec: { rawStdout: "💩".repeat(_testables.MAX_LOG_SQL_BYTES / 2) } }),
  }))).json();
  await state.drain();
  const logs = await (await doInst.fetch(new Request("https://do/logs?ownerId=owner-R2"))).json();
  assert.ok(logs.logRefs.length >= 1);
  assert.equal("r2Key" in logs.logRefs[0], false, "public refs do not expose the internal object key");
  const terminalBefore = state.storage.sql.exec("SELECT terminal FROM run_state WHERE run_id = ?", admitted.runId).toArray()[0].terminal;

  const ref = await doInst.fetch(new Request(`https://do/logs/ref?ownerId=owner-R2&seq=${logs.logRefs[0].seq}`));
  assert.equal(ref.status, 200);
  assert.equal(ref.headers.get("x-terrarium-log-sha256"), logs.logRefs[0].sha256);
  assert.equal((await ref.arrayBuffer()).byteLength, logs.logRefs[0].byteCount);
  assert.equal((await doInst.fetch(new Request(`https://do/logs/ref?ownerId=other&seq=${logs.logRefs[0].seq}`))).status, 403);

  state.storage.sql.exec("UPDATE log_offload SET sha256 = ? WHERE run_id = ?", "0".repeat(64), admitted.runId);
  const corrupt = await doInst.fetch(new Request(`https://do/logs/ref?ownerId=owner-R2&seq=${logs.logRefs[0].seq}`));
  assert.equal(corrupt.status, 502);
  assert.deepEqual(await corrupt.json(), { ok: false, code: "R2_CORRUPT" });
  const terminalAfter = state.storage.sql.exec("SELECT terminal FROM run_state WHERE run_id = ?", admitted.runId).toArray()[0].terminal;
  assert.equal(terminalAfter, terminalBefore, "post-terminal retrieval failure is read-only");
});

test("DO logs endpoint fails closed on cross-owner", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const env = { __TERRARIUM_TEST_BACKEND__: backend };
  const doInst = new RunControlDO(state, env);
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "logs", ownerId: "owner-A" }),
  }));
  await state.drain();
  const res = await doInst.fetch(new Request("https://do/logs?ownerId=owner-B", { method: "GET" }));
  assert.equal(res.status, 403);
});

// ---------------- control-plane index projection ----------------

/** Fake Workers KV matching the surface run-index uses. */
function makeIndexKV() {
  const store = new Map();
  return {
    store,
    async put(k, v) { store.set(k, v); },
    async get(k, opts) { const raw = store.get(k); return raw == null ? null : (opts?.type === "json" ? JSON.parse(raw) : raw); },
    async list({ prefix = "" } = {}) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
}

test("index projection: admit writes a running record; collect marks it terminal (channel grouping key)", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const kv = makeIndexKV();
  const env = { __TERRARIUM_TEST_BACKEND__: backend, TERRARIUM_LEDGER: kv };
  const doInst = new RunControlDO(state, env);

  const res = await doInst.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "indexed run", ownerId: "owner-IDX", spec: { channel: "loop-97", workflowId: "loop-97" } }),
  }));
  assert.equal(res.status, 202);
  await state.drain();

  // Admit projection landed, grouped by channel. NOTE: DetachedProcessBackend
  // finalizes synchronously, so driveToTerminal (also waitUntil-anchored) may
  // already have flipped the record to terminal by drain() time. Assert the
  // record exists with the admit-time fields; status is checked after collect.
  const keys = [...kv.store.keys()];
  assert.equal(keys.length, 1, "exactly one index record after admit");
  const rec = JSON.parse(kv.store.get(keys[0]));
  assert.ok(["running", "done"].includes(rec.status), `admit record status is running or done (was ${rec.status})`);
  assert.equal(rec.channel, "loop-97");
  assert.equal(rec.grounding, "cloud");
  assert.equal(rec.ownerId, "owner-IDX");

  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-IDX" }),
  }));
  assert.equal((await collect.json()).ok, true);
  await state.drain();

  const after = JSON.parse(kv.store.get(keys[0]));
  assert.equal(after.status, "done", "terminal hook updated the same record");
  assert.equal(after.ok, true);
  assert.equal(after.channel, "loop-97", "channel preserved across terminal update");
  assert.ok(Number.isFinite(after.terminalAt));
});

test("index projection: workflowId trap default (== runId) is dropped", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const kv = makeIndexKV();
  const env = { __TERRARIUM_TEST_BACKEND__: backend, TERRARIUM_LEDGER: kv };
  const doInst = new RunControlDO(state, env);

  const res = await doInst.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "trap wf", ownerId: "owner-T" }),
  }));
  await res.json();
  await state.drain();
  const runId = (await (await doInst.fetch(new Request("https://do/status?ownerId=owner-T"))).json()).status.runId;
  const rec = JSON.parse([...kv.store.values()][0]);
  // No explicit workflowId was passed, so it must be null (never the runId trap).
  assert.equal(rec.workflowId, null);
  assert.notEqual(rec.workflowId, runId);
});

test("index projection is fail-soft: a broken KV never fails admission or finalize", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const brokenKV = { put: async () => { throw new Error("KV down"); }, get: async () => { throw new Error("KV down"); }, list: async () => { throw new Error("KV down"); } };
  const env = { __TERRARIUM_TEST_BACKEND__: backend, TERRARIUM_LEDGER: brokenKV };
  const doInst = new RunControlDO(state, env);

  const res = await doInst.fetch(new Request("https://do/admit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "resilient", ownerId: "owner-R", spec: { channel: "c" } }),
  }));
  assert.equal(res.status, 202, "admission succeeds despite a broken index KV");
  await state.drain();

  const collect = await doInst.fetch(new Request("https://do/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-R" }),
  }));
  const cb = await collect.json();
  assert.equal(cb.ok, true, "finalize succeeds despite a broken index KV");
  assert.equal(cb.terminal.status, "done");
});
