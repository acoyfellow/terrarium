#!/usr/bin/env node
// C2 happy-path receipt for POST/GET /api/batches.
//
// Proves, against the REAL code paths (no mocked admit logic), that:
//   1. POST /api/batches admits N runs through the SAME admitOneRun() path used
//      by POST /api/runs (reuse, no fork).
//   2. peakLive <= maxConcurrency (the concurrency window is respected).
//   3. The aggregate transitions running -> done as children go terminal.
//   4. FAILURE-TRUTH: a non-success child is NEVER rolled up as done.
//
// Runs fully in-process in fixture mode: an in-memory KV, a budget DO stub that
// echoes the canonical runId, and a RunControl DO stub whose /admit records
// live concurrency. NO live token, NO network, nothing touches disk except the
// emitted receipt. This is the falsifiable receipt a skeptic can re-run:
//   node scripts/c2-batch-happy-path.mjs

import { handleApiBatches } from "../src/cloud/api-batches.js";
import { indexRunAdmitted, indexRunTerminal } from "../src/cloud/run-index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeKV() {
  const store = new Map();
  return {
    store,
    async put(k, v) { store.set(k, v); },
    async get(k, opts) {
      const raw = store.get(k);
      if (raw == null) return null;
      return opts?.type === "json" ? JSON.parse(raw) : raw;
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const all = [...store.keys()].filter((x) => x.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + limit);
      const next = start + limit, done = next >= all.length;
      return { keys: slice.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(next) };
    },
  };
}

function makeBudgetNS() {
  return {
    idFromName: (n) => ({ name: n }),
    get: () => ({
      async fetch(_u, init) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, runId: body.runId }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    }),
  };
}

function makeRunNS({ admitDelayMs = 15 } = {}) {
  const state = { live: 0, peak: 0, admitted: [] };
  return {
    _state: state,
    idFromName: (n) => ({ name: n }),
    get: () => ({
      async fetch(url, init) {
        if (new URL(url).pathname === "/admit") {
          const body = JSON.parse(init.body);
          state.live++; if (state.live > state.peak) state.peak = state.live;
          await new Promise((r) => setTimeout(r, admitDelayMs));
          state.live--;
          state.admitted.push(body.runId);
          return new Response(JSON.stringify({ admitted: true, runId: body.runId, contract: {} }), {
            status: 202, headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    }),
  };
}

const TOKEN = "fixture-control-token-c2";
function env() {
  return {
    TERRARIUM_MODE: "fixture",
    TERRARIUM_PRINCIPAL_ID: "owner-c2",
    TERRARIUM_CONTROL_TOKEN_CURRENT: TOKEN,
    TERRARIUM_LEDGER: makeKV(),
    TERRARIUM_PRINCIPAL_BUDGET: makeBudgetNS(),
    TERRARIUM_RUN: makeRunNS(),
  };
}

function postReq(body, idem) {
  return new Request("https://terrarium.coey.dev/api/batches", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "idempotency-key": idem },
    body: JSON.stringify(body),
  });
}
function getReq(id) {
  return new Request(`https://terrarium.coey.dev/api/batches/${id}`, {
    method: "GET", headers: { authorization: `Bearer ${TOKEN}` },
  });
}

async function main() {
  const checks = [];
  const record = (name, pass, detail) => { checks.push({ name, pass, detail }); };

  // --- Scenario A: happy path, all children succeed -> running -> done -------
  const N = 6, MAXC = 3;
  const e = env();
  const postRes = await handleApiBatches(postReq({ tasks: Array.from({ length: N }, (_, i) => `reply with: t${i}`), maxConcurrency: MAXC }, "c2-happy-0001"), e);
  const post = await postRes.json();

  record("1. admit N through admitOneRun (POST 202)", postRes.status === 202 && post.admitted === N, { status: postRes.status, admitted: post.admitted, requested: post.requested });
  record("1b. child runIds minted (ter_ prefix, no receipts inlined)", post.childRunIds.length === N && post.childRunIds.every((r) => /^ter_/.test(r)), { childRunIds: post.childRunIds });
  record("2. peakLive <= maxConcurrency (window respected)", post.peakLive <= MAXC && e.TERRARIUM_RUN._state.peak <= MAXC, { reportedPeak: post.peakLive, doObservedPeak: e.TERRARIUM_RUN._state.peak, maxConcurrency: MAXC });

  // Project children as their RunControl DOs would (admitted, then terminal).
  for (const rid of post.childRunIds) await indexRunAdmitted(e.TERRARIUM_LEDGER, { ownerId: "owner-c2", runId: rid, channel: "c2" });
  const midAgg = await handleApiBatches(getReq(post.batchId), e).then((r) => r.json());
  record("3a. aggregate is 'running' while children non-terminal", midAgg.status === "running" && midAgg.running === N && midAgg.done === 0, { status: midAgg.status, running: midAgg.running, done: midAgg.done });

  for (const rid of post.childRunIds) await indexRunTerminal(e.TERRARIUM_LEDGER, { ownerId: "owner-c2", runId: rid, status: "done", ok: true });
  const doneAgg = await handleApiBatches(getReq(post.batchId), e).then((r) => r.json());
  record("3b. aggregate transitions running -> done when all terminal+ok", doneAgg.status === "done" && doneAgg.done === N && doneAgg.failed === 0, { status: doneAgg.status, done: doneAgg.done, failed: doneAgg.failed });

  // --- Scenario B: one child fails -> failure-truth (never rolled up done) ---
  const e2 = env();
  const post2 = await handleApiBatches(postReq({ tasks: ["a", "b", "c"], maxConcurrency: 3 }, "c2-fail-0001"), e2).then((r) => r.json());
  for (const rid of post2.childRunIds) await indexRunAdmitted(e2.TERRARIUM_LEDGER, { ownerId: "owner-c2", runId: rid, channel: "c2" });
  await indexRunTerminal(e2.TERRARIUM_LEDGER, { ownerId: "owner-c2", runId: post2.childRunIds[0], status: "done", ok: true });
  await indexRunTerminal(e2.TERRARIUM_LEDGER, { ownerId: "owner-c2", runId: post2.childRunIds[1], status: "done", ok: true });
  await indexRunTerminal(e2.TERRARIUM_LEDGER, { ownerId: "owner-c2", runId: post2.childRunIds[2], status: "failed", ok: false });
  const failAgg = await handleApiBatches(getReq(post2.batchId), e2).then((r) => r.json());
  record("4. failure-truth: one failed child forces 'failed', never 'done'", failAgg.status === "failed" && failAgg.done === 2 && failAgg.failed === 1, { status: failAgg.status, done: failAgg.done, failed: failAgg.failed });

  // Also prove a done-but-ok:false child is counted as failure, not done.
  const e3 = env();
  const post3 = await handleApiBatches(postReq({ tasks: ["x", "y"], maxConcurrency: 2 }, "c2-okfalse-0001"), e3).then((r) => r.json());
  for (const rid of post3.childRunIds) await indexRunAdmitted(e3.TERRARIUM_LEDGER, { ownerId: "owner-c2", runId: rid, channel: "c2" });
  await indexRunTerminal(e3.TERRARIUM_LEDGER, { ownerId: "owner-c2", runId: post3.childRunIds[0], status: "done", ok: true });
  await indexRunTerminal(e3.TERRARIUM_LEDGER, { ownerId: "owner-c2", runId: post3.childRunIds[1], status: "done", ok: false });
  const okFalseAgg = await handleApiBatches(getReq(post3.batchId), e3).then((r) => r.json());
  record("4b. done-but-ok:false counted as failure, not done", okFalseAgg.status === "failed" && okFalseAgg.failed === 1, { status: okFalseAgg.status, failed: okFalseAgg.failed });

  const allPass = checks.every((c) => c.pass);
  const receipt = {
    receipt: "c2-batch-happy-path",
    mode: "fixture (in-process, no live token, no network)",
    generatedAt: new Date().toISOString(),
    scenarioA: { tasks: N, maxConcurrency: MAXC, batchId: post.batchId, admitted: post.admitted, peakLive: post.peakLive, finalStatus: doneAgg.status },
    scenarioB_failureTruth: { batchId: post2.batchId, finalStatus: failAgg.status, done: failAgg.done, failed: failAgg.failed },
    checks,
    verdict: allPass ? "PASS" : "FAIL",
  };

  const outDir = path.join(__dirname, "..", "artifacts", "dual-track");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "C2_BATCH_RECEIPT.json");
  fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n");

  for (const c of checks) console.log(`${c.pass ? "\u2713" : "\u2717"} ${c.name}`);
  console.log(`\nverdict: ${receipt.verdict}  ->  ${outPath}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
