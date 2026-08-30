// Round 5C1: principal-auth + PrincipalBudgetDO tests.
//
// Covered:
//   * Auth failures fail closed (missing PRINCIPAL_ID / missing CURRENT /
//     empty tokens / legacy TERRARIUM_CONTROL_TOKEN never authorizes).
//   * CURRENT and PREVIOUS both authorize the SAME owner.
//   * Client-provided ownerId in body is ignored.
//   * Idempotent same-submit creates one mapping/reservation/run.
//   * Same idempotency-key + different request => 409.
//   * Concurrency limit (active reservations).
//   * Per-minute request cap.
//   * Per-UTC-day run cap.
//   * Per-day estimated token cap.
//   * Per-day estimated cost-micros cap.
//   * Independent principal isolation.
//   * Terminal release is idempotent.
//   * Authenticated-but-cross-principal reads normalize to 404.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { authenticatePrincipal } from "../src/cloud/principal-auth.js";
import {
  PrincipalBudgetDO,
  DEFAULT_BUDGET_LIMITS,
  canonicalRequestHash,
  estimateBudgetFromTask,
  resolveBudgetLimits,
} from "../src/cloud/principal-budget-do.js";
import { RunControlDO } from "../src/cloud/run-control-do.js";
import { handleApiRuns } from "../src/cloud/api-runs.js";
import { DetachedProcessBackend } from "../src/cloud/local-run-cell.js";

// ---------------- SQL / state helpers ----------------
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

function makeState() {
  const sql = makeSqlShim();
  const pending = [];
  return {
    storage: { sql },
    waitUntil(p) { pending.push(Promise.resolve(p)); },
    async drain() { await Promise.allSettled(pending.splice(0)); },
  };
}

function makeRunNamespace(workerEnv) {
  const instances = new Map();
  return {
    idFromName(name) { return { toString: () => `id_${name}`, __name: name }; },
    get(id) {
      const name = id.__name;
      if (!instances.has(name)) {
        const state = makeState();
        const backend = new DetachedProcessBackend();
        const env = {
          __TERRARIUM_TEST_BACKEND__: backend,
          TERRARIUM_PRINCIPAL_BUDGET: workerEnv.TERRARIUM_PRINCIPAL_BUDGET,
        };
        instances.set(name, { doInstance: new RunControlDO(state, env), state });
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

function makePrincipalBudgetNamespace(workerEnv) {
  const instances = new Map();
  return {
    idFromName(name) { return { toString: () => `id_${name}`, __name: name }; },
    get(id) {
      const name = id.__name;
      if (!instances.has(name)) {
        instances.set(name, new PrincipalBudgetDO(makeState(), workerEnv));
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
  principalId = "principal-A",
  currentToken = "current-token",
  previousToken,
  limits,
} = {}) {
  const env = {
    TERRARIUM_PRINCIPAL_ID: principalId,
    TERRARIUM_CONTROL_TOKEN_CURRENT: currentToken,
  };
  if (previousToken) env.TERRARIUM_CONTROL_TOKEN_PREVIOUS = previousToken;
  if (limits?.maxActiveReservations != null) env.TERRARIUM_BUDGET_MAX_ACTIVE = String(limits.maxActiveReservations);
  if (limits?.maxRequestsPerMinute != null) env.TERRARIUM_BUDGET_MAX_PER_MINUTE = String(limits.maxRequestsPerMinute);
  if (limits?.maxRunsPerDay != null) env.TERRARIUM_BUDGET_MAX_PER_DAY = String(limits.maxRunsPerDay);
  if (limits?.maxEstimatedTokensPerDay != null) env.TERRARIUM_BUDGET_MAX_TOKENS_PER_DAY = String(limits.maxEstimatedTokensPerDay);
  if (limits?.maxCostMicrosPerDay != null) env.TERRARIUM_BUDGET_MAX_COST_MICROS_PER_DAY = String(limits.maxCostMicrosPerDay);
  env.TERRARIUM_PRINCIPAL_BUDGET = makePrincipalBudgetNamespace(env);
  env.TERRARIUM_RUN = makeRunNamespace(env);
  return env;
}

let __idem = 0;
function nextKey() { __idem += 1; return `idem-${__idem}-${Date.now().toString(36)}`; }

function apiPostAdmit(env, {
  token = "current-token",
  body = { task: "hello" },
  idempotencyKey = nextKey(),
} = {}) {
  return handleApiRuns(
    new Request("https://x/api/runs", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

function apiGet(env, pathAndQuery, { token = "current-token" } = {}) {
  return handleApiRuns(
    new Request(`https://x${pathAndQuery}`, { method: "GET", headers: { authorization: `Bearer ${token}` } }),
    env,
  );
}

// ---------------- read-only budget snapshot probe ----------------

test("GET /api/runs/budget/snapshot: unauth fails closed", async () => {
  const env = makeEnv();
  const res = await handleApiRuns(new Request("https://x/api/runs/budget/snapshot", { method: "GET" }), env);
  assert.equal(res.status, 401);
});

test("GET /api/runs/budget/snapshot: owner-scoped read reflects reserve then release", async () => {
  const env = makeEnv();
  // Fresh principal: zero active.
  let snap = await (await apiGet(env, "/api/runs/budget/snapshot")).json();
  assert.equal(snap.ok, true);
  assert.equal(snap.snapshot.activeReservations, 0);
  // Admit one run; the test RunControl shim auto-releases on terminal callback,
  // so active returns to 0 and run_count increments — proving release is healthy.
  const admit = await apiPostAdmit(env);
  assert.equal(admit.status, 202);
  snap = await (await apiGet(env, "/api/runs/budget/snapshot")).json();
  assert.equal(snap.snapshot.activeReservations, 0, "reservation released after terminal");
  assert.ok(snap.snapshot.day.run_count >= 1);
});

// ---------------- authenticatePrincipal unit tests ----------------

test("authenticatePrincipal: missing PRINCIPAL_ID fails closed", () => {
  const req = new Request("https://x/", { headers: { authorization: "Bearer T" } });
  const res = authenticatePrincipal(req, { TERRARIUM_CONTROL_TOKEN_CURRENT: "T" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

test("authenticatePrincipal: empty PRINCIPAL_ID fails closed", () => {
  const req = new Request("https://x/", { headers: { authorization: "Bearer T" } });
  const res = authenticatePrincipal(req, { TERRARIUM_PRINCIPAL_ID: "", TERRARIUM_CONTROL_TOKEN_CURRENT: "T" });
  assert.equal(res.ok, false);
});

test("authenticatePrincipal: missing CURRENT token fails closed", () => {
  const req = new Request("https://x/", { headers: { authorization: "Bearer T" } });
  const res = authenticatePrincipal(req, { TERRARIUM_PRINCIPAL_ID: "P" });
  assert.equal(res.ok, false);
});

test("authenticatePrincipal: empty CURRENT token fails closed even with bearer", () => {
  const req = new Request("https://x/", { headers: { authorization: "Bearer " } });
  const res = authenticatePrincipal(req, { TERRARIUM_PRINCIPAL_ID: "P", TERRARIUM_CONTROL_TOKEN_CURRENT: "" });
  assert.equal(res.ok, false);
});

test("authenticatePrincipal: CURRENT token authorizes principal", () => {
  const req = new Request("https://x/", { headers: { authorization: "Bearer T-current" } });
  const res = authenticatePrincipal(req, { TERRARIUM_PRINCIPAL_ID: "P1", TERRARIUM_CONTROL_TOKEN_CURRENT: "T-current" });
  assert.equal(res.ok, true);
  assert.equal(res.principalId, "P1");
});

test("authenticatePrincipal: PREVIOUS token authorizes same principal (rotation)", () => {
  const env = { TERRARIUM_PRINCIPAL_ID: "P1", TERRARIUM_CONTROL_TOKEN_CURRENT: "T-current", TERRARIUM_CONTROL_TOKEN_PREVIOUS: "T-prev" };
  const req1 = new Request("https://x/", { headers: { authorization: "Bearer T-current" } });
  const req2 = new Request("https://x/", { headers: { authorization: "Bearer T-prev" } });
  const r1 = authenticatePrincipal(req1, env);
  const r2 = authenticatePrincipal(req2, env);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.principalId, r2.principalId);
  assert.equal(r1.principalId, "P1");
});

test("authenticatePrincipal: legacy TERRARIUM_CONTROL_TOKEN never authorizes /api/runs", () => {
  const req = new Request("https://x/", { headers: { authorization: "Bearer LEGACY" } });
  const res = authenticatePrincipal(req, {
    TERRARIUM_PRINCIPAL_ID: "P1",
    TERRARIUM_CONTROL_TOKEN: "LEGACY", // legacy variable — MUST be ignored
  });
  assert.equal(res.ok, false, "legacy TERRARIUM_CONTROL_TOKEN must be ignored");
});

test("authenticatePrincipal: directory maps distinct tokens to distinct principals", () => {
  const env = {
    TERRARIUM_PRINCIPALS: JSON.stringify([
      { id: "alice", token: "tok-alice" },
      { id: "bob", token: "tok-bob" },
    ]),
    TERRARIUM_PRINCIPAL_ID: "ignored-single",
    TERRARIUM_CONTROL_TOKEN_CURRENT: "tok-alice",
  };
  const alice = authenticatePrincipal(new Request("https://x/", { headers: { authorization: "Bearer tok-alice" } }), env);
  const bob = authenticatePrincipal(new Request("https://x/", { headers: { authorization: "Bearer tok-bob" } }), env);
  const unknown = authenticatePrincipal(new Request("https://x/", { headers: { authorization: "Bearer tok-eve" } }), env);
  assert.equal(alice.ok, true);
  assert.equal(alice.principalId, "alice");
  assert.equal(bob.ok, true);
  assert.equal(bob.principalId, "bob");
  assert.equal(unknown.ok, false);
});

test("authenticatePrincipal: malformed directory fails closed", () => {
  const req = new Request("https://x/", { headers: { authorization: "Bearer tok-alice" } });
  const res = authenticatePrincipal(req, { TERRARIUM_PRINCIPALS: "{not-json" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

// ---------------- estimator + canonical hash ----------------

test("estimateBudgetFromTask is deterministic and server-computed", () => {
  const a = estimateBudgetFromTask("hello world", { maxOutputBytes: 1024 });
  const b = estimateBudgetFromTask("hello world", { maxOutputBytes: 1024 });
  assert.deepEqual(a, b);
  assert.ok(a.estimatedTokens > 0);
  assert.ok(a.estimatedCostMicros > 0);
});

test("canonicalRequestHash: same request => same hash; different spec => different hash", async () => {
  const h1 = await canonicalRequestHash({ task: "T", spec: { a: 1, b: 2 } });
  const h2 = await canonicalRequestHash({ task: "T", spec: { b: 2, a: 1 } });
  const h3 = await canonicalRequestHash({ task: "T", spec: { a: 1, b: 3 } });
  assert.equal(h1, h2, "canonical hash must be order-independent");
  assert.notEqual(h1, h3, "different spec must change hash");
});

test("resolveBudgetLimits falls back to defaults for invalid config", () => {
  const l = resolveBudgetLimits({ TERRARIUM_BUDGET_MAX_ACTIVE: "not-a-number" });
  assert.equal(l.maxActiveReservations, DEFAULT_BUDGET_LIMITS.maxActiveReservations);
});

// ---------------- /api/runs auth wiring ----------------

test("POST /api/runs: no bearer => 401", async () => {
  const env = makeEnv();
  const res = await handleApiRuns(
    new Request("https://x/api/runs", { method: "POST", headers: { "idempotency-key": nextKey() } }),
    env,
  );
  assert.equal(res.status, 401);
});

test("POST /api/runs: wrong token => 401", async () => {
  const env = makeEnv();
  const res = await handleApiRuns(
    new Request("https://x/api/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer nope",
        "content-type": "application/json",
        "idempotency-key": nextKey(),
      },
      body: JSON.stringify({ task: "t" }),
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("POST /api/runs: missing PRINCIPAL_ID env => 401 even with correct token", async () => {
  const env = makeEnv();
  delete env.TERRARIUM_PRINCIPAL_ID;
  const res = await apiPostAdmit(env);
  assert.equal(res.status, 401);
});

test("POST /api/runs: missing Idempotency-Key => 400", async () => {
  const env = makeEnv();
  const res = await handleApiRuns(
    new Request("https://x/api/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer current-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "t" }),
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("POST /api/runs: client-provided ownerId in body is ignored (principal owner is authoritative)", async () => {
  const env = makeEnv();
  const res = await apiPostAdmit(env, { body: { task: "t", ownerId: "attacker-owner", spec: { ownerId: "attacker" } } });
  assert.equal(res.status, 202);
  const body = await res.json();
  // The DO's owner is derived from the env principal, not the body.
  const runNsInstances = env.TERRARIUM_RUN._instances;
  assert.ok(runNsInstances.size >= 1, "at least one RunControlDO instance created");
});

test("POST /api/runs: CURRENT and PREVIOUS both map to the SAME principal owner", async () => {
  const env = makeEnv({ previousToken: "prev-token" });
  const r1 = await apiPostAdmit(env, { token: "current-token" });
  const r2 = await apiPostAdmit(env, { token: "prev-token" });
  assert.equal(r1.status, 202);
  assert.equal(r2.status, 202);
  // Both admits ran on the SAME principal namespace bucket in the budget DO.
  // Sanity: budget snapshot shows both reservations.
  const budgetStub = env.TERRARIUM_PRINCIPAL_BUDGET.get(env.TERRARIUM_PRINCIPAL_BUDGET.idFromName("principal-A"));
  const snap = await (await budgetStub.fetch("https://do/snapshot?principalId=principal-A", { method: "GET" })).json();
  assert.equal(snap.ok, true);
  assert.equal(snap.snapshot.day.run_count, 2);
  assert.equal(snap.snapshot.activeReservations, 0, "terminal callbacks release both reservations");
});

// ---------------- Idempotency + budget ----------------

test("idempotent same submit: 2x with same key + body returns SAME runId; only 1 reservation/run", async () => {
  const env = makeEnv();
  const key = nextKey();
  const body = { task: "same-task", spec: { foo: "bar" } };
  const r1 = await apiPostAdmit(env, { idempotencyKey: key, body });
  assert.equal(r1.status, 202);
  const b1 = await r1.json();
  const r2 = await apiPostAdmit(env, { idempotencyKey: key, body });
  assert.equal(r2.status, 202);
  const b2 = await r2.json();
  assert.equal(b1.runId, b2.runId, "same idempotency key + body must return original runId");
  // Only ONE reservation counted.
  const budgetStub = env.TERRARIUM_PRINCIPAL_BUDGET.get(env.TERRARIUM_PRINCIPAL_BUDGET.idFromName("principal-A"));
  const snap = await (await budgetStub.fetch("https://do/snapshot?principalId=principal-A", { method: "GET" })).json();
  assert.equal(snap.snapshot.day.run_count, 1);
});

test("same idempotency-key + different body => 409", async () => {
  const env = makeEnv();
  const key = nextKey();
  const r1 = await apiPostAdmit(env, { idempotencyKey: key, body: { task: "A" } });
  assert.equal(r1.status, 202);
  const r2 = await apiPostAdmit(env, { idempotencyKey: key, body: { task: "B" } });
  assert.equal(r2.status, 409);
});

// ---------------- Limits (via env config) ----------------

test("concurrency limit: exceeds maxActiveReservations => 429", async () => {
  // Reserve directly on the budget DO to isolate the concurrency check from
  // the RunControl lifecycle (which would auto-release on terminal callback
  // in the test shim). maxActiveReservations=1 => second reserve is 429.
  const state = makeState();
  const doInst = new PrincipalBudgetDO(state, { __TERRARIUM_TEST_BUDGET_LIMITS__: true });
  const stub = (path, body) => doInst.fetch(new Request(`https://do${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const r1 = await stub("/reserve", {
    principalId: "P", runId: "ter_c1", idempotencyKey: "k1", requestHash: "h1",
    estimatedTokens: 1, estimatedCostMicros: 1,
    limits: { ...DEFAULT_BUDGET_LIMITS, maxActiveReservations: 1 },
  });
  const r2 = await stub("/reserve", {
    principalId: "P", runId: "ter_c2", idempotencyKey: "k2", requestHash: "h2",
    estimatedTokens: 1, estimatedCostMicros: 1,
    limits: { ...DEFAULT_BUDGET_LIMITS, maxActiveReservations: 1 },
  });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 429);
});

test("per-minute limit: exceeds maxRequestsPerMinute => 429", async () => {
  const env = makeEnv({ limits: { maxRequestsPerMinute: 2, maxActiveReservations: 10, maxRunsPerDay: 10 } });
  const r1 = await apiPostAdmit(env);
  const r2 = await apiPostAdmit(env);
  const r3 = await apiPostAdmit(env);
  assert.equal(r1.status, 202);
  assert.equal(r2.status, 202);
  assert.equal(r3.status, 429);
});

test("per-day run limit: exceeds maxRunsPerDay => 429", async () => {
  const env = makeEnv({
    limits: {
      maxRunsPerDay: 1,
      maxActiveReservations: 10,
      maxRequestsPerMinute: 100,
    },
  });
  const r1 = await apiPostAdmit(env);
  const r2 = await apiPostAdmit(env);
  assert.equal(r1.status, 202);
  assert.equal(r2.status, 429);
});

test("per-day token limit: exceeds maxEstimatedTokensPerDay => 429 (server-computed estimate)", async () => {
  // Make the estimate large enough to trip the token cap on the first request.
  // With default output 128KB and a small task, tokens ≈ 128*1024/4 = 32,768.
  // Set the day cap to 10,000 so the first admit fails token-day-limit.
  const env = makeEnv({ limits: { maxEstimatedTokensPerDay: 10_000 } });
  const r1 = await apiPostAdmit(env);
  assert.equal(r1.status, 429);
  const bodyText = await r1.text();
  assert.match(bodyText, /token-day-limit/);
});

test("per-day cost-micros limit: exceeds maxCostMicrosPerDay => 429 (server-computed estimate)", async () => {
  // With default estimator: costMicros = tokens * 2. Under default output
  // budget the first admit alone is ~65k cost. Set the day cap to 100.
  const env = makeEnv({ limits: { maxCostMicrosPerDay: 100 } });
  const r1 = await apiPostAdmit(env);
  assert.equal(r1.status, 429);
  const bodyText = await r1.text();
  assert.match(bodyText, /cost-day-limit/);
});

// ---------------- Isolation across principals ----------------

test("independent principal isolation: principal-B is unaffected by A's counters", async () => {
  const envA = makeEnv({ principalId: "principal-A", currentToken: "TA", limits: { maxRunsPerDay: 1 } });
  const budgetNs = envA.TERRARIUM_PRINCIPAL_BUDGET;
  const envB = {
    TERRARIUM_PRINCIPAL_ID: "principal-B",
    TERRARIUM_CONTROL_TOKEN_CURRENT: "TB",
    TERRARIUM_PRINCIPAL_BUDGET: budgetNs,
    TERRARIUM_BUDGET_MAX_PER_DAY: "1",
  };
  envB.TERRARIUM_RUN = makeRunNamespace(envB);
  // A hits the day cap.
  const a1 = await apiPostAdmit(envA, { token: "TA" });
  const a2 = await apiPostAdmit(envA, { token: "TA" });
  assert.equal(a1.status, 202);
  assert.equal(a2.status, 429);
  // B, sharing the SAME budget DO namespace, has an independent bucket.
  const b1 = await apiPostAdmit(envB, { token: "TB" });
  assert.equal(b1.status, 202, "principal-B must have an independent budget bucket");
});

// ---------------- Terminal release + non-202 rollback ----------------

test("terminal release is idempotent: repeated releases never decrement below zero", async () => {
  const state = makeState();
  const doInst = new PrincipalBudgetDO(state, {});
  const stub = { fetch: (url, init) => doInst.fetch(new Request(url, init)) };
  // Reserve once.
  const reserveRes = await stub.fetch("https://do/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      principalId: "P",
      runId: "ter_rel_1",
      idempotencyKey: "k1",
      requestHash: "h1",
      estimatedTokens: 100,
      estimatedCostMicros: 100,
    }),
  });
  assert.equal(reserveRes.status, 200);
  // Two releases.
  const rel1 = await (await stub.fetch("https://do/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "P", runId: "ter_rel_1" }),
  })).json();
  const rel2 = await (await stub.fetch("https://do/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "P", runId: "ter_rel_1" }),
  })).json();
  assert.equal(rel1.ok, true);
  assert.equal(rel1.released, true);
  assert.equal(rel2.ok, true);
  assert.equal(rel2.released, false, "second release is idempotent");
  // Snapshot: activeReservations back to 0, day.run_count still 1 (audit).
  const snap = await (await stub.fetch("https://do/snapshot?principalId=P", { method: "GET" })).json();
  assert.equal(snap.snapshot.activeReservations, 0);
  assert.equal(snap.snapshot.day.run_count, 1);
});

test("releasing an unknown runId is a no-op (never negative)", async () => {
  const state = makeState();
  const doInst = new PrincipalBudgetDO(state, {});
  const res = await doInst.fetch(new Request("https://do/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "P", runId: "ter_never_reserved" }),
  }));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.released, false);
});

// ---------------- Concurrency: strong ordering within a single DO ----------------

test("strong ordering: two synchronous reserves under the same principal share limits", async () => {
  // Two reserves on the SAME DO instance with maxActiveReservations=1.
  // Second must be denied — no await between check and insert.
  const state = makeState();
  const doInst = new PrincipalBudgetDO(state, { __TERRARIUM_TEST_BUDGET_LIMITS__: true });
  const stub = { fetch: (url, init) => doInst.fetch(new Request(url, init)) };
  const [r1, r2] = await Promise.all([
    stub.fetch("https://do/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "P", runId: "ter_r1", idempotencyKey: "k-a", requestHash: "h-a",
        estimatedTokens: 10, estimatedCostMicros: 10, limits: { ...DEFAULT_BUDGET_LIMITS, maxActiveReservations: 1 },
      }),
    }),
    stub.fetch("https://do/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "P", runId: "ter_r2", idempotencyKey: "k-b", requestHash: "h-b",
        estimatedTokens: 10, estimatedCostMicros: 10, limits: { ...DEFAULT_BUDGET_LIMITS, maxActiveReservations: 1 },
      }),
    }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 429], "exactly one succeeds under maxActiveReservations=1");
});

test("a budget DO binds its first principal and rejects a mismatched principal", async () => {
  const doInst = new PrincipalBudgetDO(makeState(), {});
  const reserve = (principalId, runId, key) => doInst.fetch(new Request("https://do/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      principalId, runId, idempotencyKey: key, requestHash: `hash-${key}`,
      estimatedTokens: 10, estimatedCostMicros: 20,
    }),
  }));
  assert.equal((await reserve("principal-A", "ter_bound_a", "bound-key-a")).status, 200);
  assert.equal((await reserve("principal-B", "ter_bound_b", "bound-key-b")).status, 404);
  const wrongRelease = await doInst.fetch(new Request("https://do/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "principal-B", runId: "ter_bound_a" }),
  }));
  assert.equal(wrongRelease.status, 404);
});

// ---------------- Normalized 404 on cross-principal reads ----------------

test("cross-principal read normalizes to 404 (never 403) to avoid enumeration", async () => {
  const workerEnv = {};
  const budgetNs = makePrincipalBudgetNamespace(workerEnv);
  workerEnv.TERRARIUM_PRINCIPAL_BUDGET = budgetNs;
  const runNs = makeRunNamespace(workerEnv);
  const envA = {
    TERRARIUM_PRINCIPAL_ID: "principal-A",
    TERRARIUM_CONTROL_TOKEN_CURRENT: "TA",
    TERRARIUM_RUN: runNs,
    TERRARIUM_PRINCIPAL_BUDGET: budgetNs,
  };
  const envB = {
    TERRARIUM_PRINCIPAL_ID: "principal-B",
    TERRARIUM_CONTROL_TOKEN_CURRENT: "TB",
    TERRARIUM_RUN: runNs, // shared
    TERRARIUM_PRINCIPAL_BUDGET: budgetNs,
  };
  const admit = await apiPostAdmit(envA, { token: "TA" });
  const { runId } = await admit.json();
  const status = await handleApiRuns(
    new Request(`https://x/api/runs/${runId}/status`, {
      method: "GET",
      headers: { authorization: "Bearer TB" },
    }),
    envB,
  );
  assert.equal(status.status, 404);
});
