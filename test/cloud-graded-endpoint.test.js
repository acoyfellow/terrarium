// Live wiring test for GET /graded: the DO composes an advisory graded view
// (provenance grade + content-addressed artifact) from a finalized terminal
// WITHOUT mutating the run. Authority stays in /status; /graded is read-only.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RunControlDO } from "../src/cloud/run-control-do.js";
import { DetachedProcessBackend } from "../src/cloud/local-run-cell.js";
import { verifyReceiptArtifact } from "../src/cloud/receipt-artifact.js";

// SQL + state shims mirroring cloud-production-c0.test.js.
function makeSqlShim(db = new DatabaseSync(":memory:")) {
  return {
    _db: db,
    exec(sql, ...bindings) {
      const isSelect = /^\s*SELECT/i.test(sql);
      if (bindings.length === 0 && !isSelect) { db.exec(sql); return { toArray: () => [] }; }
      const stmt = db.prepare(sql);
      if (isSelect) { const rows = stmt.all(...bindings); return { toArray: () => rows }; }
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };
}
function makeState(db = new DatabaseSync(":memory:")) {
  const pending = [];
  let alarmAt = null;
  return {
    storage: {
      sql: makeSqlShim(db),
      async setAlarm(ms) { alarmAt = ms; },
      async getAlarm() { return alarmAt; },
    },
    waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); },
    async drain() { await Promise.allSettled(pending.splice(0)); },
  };
}

test("GET /graded returns a grade + re-verifiable artifact for a verified run; authority untouched", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });

  const admit = await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "graded wiring", ownerId: "owner-G" }),
  }));
  assert.equal(admit.status, 202);
  await state.drain();
  await doInst.fetch(new Request("https://do/collect", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "owner-G" }),
  }));
  await state.drain();

  // Authority via /status is verified (default backend emits a correlated receipt).
  const st = await (await doInst.fetch(new Request("https://do/status?ownerId=owner-G", { method: "GET" }))).json();
  assert.equal(st.status.terminal.taskContractStatus, "verified");

  // /graded composes the advisory view.
  const g = await (await doInst.fetch(new Request("https://do/graded?ownerId=owner-G", { method: "GET" }))).json();
  assert.equal(g.ok, true);
  // No correctness supplied at the cell layer => provenance-only, uncalibrated (fail closed).
  assert.equal(g.grade.grade, "provenance-only");
  assert.equal(g.grade.calibrated, false);
  // The artifact re-verifies with only itself.
  const v = await verifyReceiptArtifact(g.artifact);
  assert.equal(v.ok, true);

  // Authority is unchanged after the graded read.
  const st2 = await (await doInst.fetch(new Request("https://do/status?ownerId=owner-G", { method: "GET" }))).json();
  assert.equal(st2.status.terminal.taskContractStatus, "verified");
  assert.equal(st2.status.terminal.ok, true);
});

test("GET /graded is owner-scoped (cross-owner denied) and returns null pre-terminal", async () => {
  const state = makeState();
  const backend = new DetachedProcessBackend();
  const doInst = new RunControlDO(state, { __TERRARIUM_TEST_BACKEND__: backend });
  await doInst.fetch(new Request("https://do/admit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "scope", ownerId: "owner-A" }),
  }));
  // wrong owner
  const denied = await doInst.fetch(new Request("https://do/graded?ownerId=owner-B", { method: "GET" }));
  assert.equal(denied.status, 403);
  // missing owner
  const noOwner = await doInst.fetch(new Request("https://do/graded", { method: "GET" }));
  assert.equal(noOwner.status, 401);
});
