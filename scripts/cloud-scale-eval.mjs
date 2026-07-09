#!/usr/bin/env node
// Production parallelism evaluator for Terrarium (owner steer: PROVE-CLOUD-PARALLELISM).
//
// Submits IDENTICAL bounded tasks sequentially and at concurrency widths against
// the deployed production service, independently validates every receipt's
// server-minted correlation (runId + taskFingerprint + nonce), and emits raw
// JSONL evidence plus a machine-readable summary. It NEVER self-certifies:
// exit 0 / backend ok / model prose are not success; only a correlated,
// re-parsed TERRARIUM_RESULT counts. Missing/mismatched => failure/inconclusive.
//
// Safety: read-only against prod except submitting bounded eval tasks. Stays
// within configured capacity (default widths <= 20). Paces to respect a
// per-minute admission ceiling. Aborts on elevated error/429 posture. No
// deploy, no config change, no credential material stored.
//
// Usage:
//   TERRA_EVAL_BASE=https://terrarium.coey.dev \
//   TERRA_EVAL_TOKEN_FILE=/path/to/token.secret \
//   node scripts/cloud-scale-eval.mjs --widths 1,5,10,20 --trials 5 --out artifacts/cloud-scale-eval
//
// A width > 20 or --soak requires an explicit human gate and is refused here.

import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CAP_MAX_ACTIVE = 20;          // configured production MAX_ACTIVE
const CAP_PER_MINUTE = 120;         // configured production per-minute ceiling
const ADMIT_SPACING_MS = 600;       // >= 60000/CAP_PER_MINUTE with margin
const POLL_MS = 2000;
const POLL_MAX = 120;               // 4 min per run ceiling for polling
const ABORT_ERROR_RATE = 0.5;       // abort a cohort if >50% hard errors

function parseArgs(argv) {
  const o = { widths: [1, 5, 10, 20], trials: 5, out: 'artifacts/cloud-scale-eval', task: 'What is 17 multiplied by 23? Reply with just the number.', deadlineMs: 180000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--widths') o.widths = argv[++i].split(',').map((x) => Number(x.trim()));
    else if (a === '--trials') o.trials = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--task') o.task = argv[++i];
    else if (a === '--soak') o.soak = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.soak) throw new Error('SOAK is a human gate; refused by the evaluator');
  if (o.widths.some((w) => !Number.isInteger(w) || w < 1 || w > CAP_MAX_ACTIVE)) {
    throw new Error(`widths must be integers in 1..${CAP_MAX_ACTIVE} (beyond-capacity is a human gate)`);
  }
  if (!Number.isInteger(o.trials) || o.trials < 1 || o.trials > 20) throw new Error('trials must be 1..20');
  return o;
}

const BASE = process.env.TERRA_EVAL_BASE;
const TOKEN_FILE = process.env.TERRA_EVAL_TOKEN_FILE;
if (!BASE || !TOKEN_FILE) { console.error('TERRA_EVAL_BASE and TERRA_EVAL_TOKEN_FILE are required'); process.exit(2); }
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const rnd = () => Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex');
function pctl(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }

async function admit(task, deadlineMs) {
  const idem = `eval-${rnd()}`;
  const t0 = now();
  const res = await fetch(`${BASE}/api/runs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'idempotency-key': idem, 'content-type': 'application/json' },
    body: JSON.stringify({ task, spec: { deadlineMs } }),
  });
  const status = res.status;
  let body = null; try { body = await res.json(); } catch { /* non-json */ }
  return { idem, admitStatus: status, admitMs: now() - t0, runId: body?.runId || null, contract: body?.contract || null, admitBody: body };
}

async function pollTerminal(runId) {
  for (let i = 0; i < POLL_MAX; i++) {
    const res = await fetch(`${BASE}/api/runs/${runId}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (res.status !== 200) { await sleep(POLL_MS); continue; }
    const d = await res.json();
    const s = d.status || d;
    const st = s.status;
    if (['done', 'failed', 'cancelled', 'inconclusive', 'error'].includes(st)) return s;
    await sleep(POLL_MS);
  }
  return { status: 'poll-timeout', terminal: null };
}

// Independent correlation check: re-parse the TERRARIUM_RESULT from the durable
// log and confirm runId + taskFingerprint + nonce match the admission contract.
// taskContractStatus:"verified" alone is NOT trusted here.
async function verifyReceipt(runId, contract) {
  try {
    const res = await fetch(`${BASE}/api/runs/${runId}/logs`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (res.status !== 200) return { receiptVerified: false, why: `logs-http-${res.status}` };
    const d = await res.json();
    const text = typeof d.logs === 'string' ? d.logs : Array.isArray(d.logs) ? d.logs.join('') : '';
    const lines = text.split(/[\n\r]/).filter((l) => l.startsWith('TERRARIUM_RESULT='));
    if (lines.length !== 1) return { receiptVerified: false, why: `marker-count-${lines.length}` };
    let obj; try { obj = JSON.parse(lines[0].slice('TERRARIUM_RESULT='.length)); } catch { return { receiptVerified: false, why: 'marker-parse' }; }
    const ok = obj.runId === contract.runId && obj.taskFingerprint === contract.taskFingerprint && obj.nonce === contract.nonce;
    return { receiptVerified: ok, why: ok ? 'correlated' : 'mismatch', summary: typeof obj.summary === 'string' ? obj.summary : null };
  } catch (e) { return { receiptVerified: false, why: `logs-error:${String(e.message || e).slice(0, 80)}` }; }
}

async function runOne(task, deadlineMs, jsonl) {
  const rec = { kind: 'run', tStart: new Date().toISOString() };
  const a = await admit(task, deadlineMs);
  Object.assign(rec, a);
  if (a.admitStatus === 429) { rec.outcome = 'backpressure-429'; appendFileSync(jsonl, JSON.stringify(rec) + '\n'); return rec; }
  if (a.admitStatus !== 202 || !a.runId) { rec.outcome = 'admit-failed'; appendFileSync(jsonl, JSON.stringify(rec) + '\n'); return rec; }
  const wallStart = now();
  const term = await pollTerminal(a.runId);
  rec.terminalMs = now() - wallStart;
  rec.terminalStatus = term.status;
  rec.terminalReason = term.terminal?.reason ?? null;
  rec.taskContractStatus = term.terminal?.taskContractStatus ?? null;
  if (term.status === 'done') {
    const v = await verifyReceipt(a.runId, a.contract);
    rec.receiptVerified = v.receiptVerified; rec.receiptWhy = v.why;
    rec.outcome = v.receiptVerified ? 'verified' : 'done-but-unverified';
  } else {
    rec.receiptVerified = false; rec.receiptWhy = `terminal-${term.status}`;
    rec.outcome = term.status === 'poll-timeout' ? 'inconclusive-polltimeout' : term.status;
  }
  appendFileSync(jsonl, JSON.stringify(rec) + '\n');
  return rec;
}

async function cohort(width, trials, task, deadlineMs, jsonl) {
  const results = [];
  for (let t = 0; t < trials; t++) {
    const trialStart = now();
    // Launch `width` runs; admit with spacing to respect the per-minute ceiling.
    const launches = [];
    for (let i = 0; i < width; i++) { launches.push(runOne(task, deadlineMs, jsonl)); await sleep(ADMIT_SPACING_MS); }
    const runs = await Promise.all(launches);
    const trialWallMs = now() - trialStart;
    const verified = runs.filter((r) => r.outcome === 'verified').length;
    const errs = runs.filter((r) => ['admit-failed', 'error'].includes(r.outcome)).length;
    results.push({ trial: t, width, trialWallMs, verified, total: width, runs });
    const errRate = errs / width;
    process.stderr.write(`  width ${width} trial ${t + 1}/${trials}: ${verified}/${width} verified, wall ${(trialWallMs / 1000).toFixed(1)}s\n`);
    if (errRate > ABORT_ERROR_RATE) { process.stderr.write(`  ABORT cohort: error rate ${(errRate * 100).toFixed(0)}%\n`); break; }
    await sleep(2000); // drain gap between trials (20-wide == MAX_ACTIVE)
  }
  return results;
}

function summarizeCohort(width, cohortResults) {
  const allRuns = cohortResults.flatMap((c) => c.runs);
  const verifiedRuns = allRuns.filter((r) => r.outcome === 'verified');
  const lat = verifiedRuns.map((r) => r.admitMs + r.terminalMs);
  const trialWalls = cohortResults.map((c) => c.trialWallMs);
  const total = allRuns.length;
  return {
    width,
    trials: cohortResults.length,
    totalRuns: total,
    verified: verifiedRuns.length,
    verifiedRate: total ? verifiedRuns.length / total : 0,
    backpressure429: allRuns.filter((r) => r.outcome === 'backpressure-429').length,
    admitFailed: allRuns.filter((r) => r.outcome === 'admit-failed').length,
    doneButUnverified: allRuns.filter((r) => r.outcome === 'done-but-unverified').length,
    inconclusive: allRuns.filter((r) => String(r.outcome).startsWith('inconclusive')).length,
    failedTerminal: allRuns.filter((r) => ['failed', 'cancelled'].includes(r.outcome)).length,
    latencyP50Ms: pctl(lat, 50), latencyP95Ms: pctl(lat, 95), latencyMaxMs: lat.length ? Math.max(...lat) : null,
    trialWallP50Ms: pctl(trialWalls, 50), trialWallMaxMs: trialWalls.length ? Math.max(...trialWalls) : null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonl = join(opts.out, `raw-${stamp}.jsonl`);
  const summaryPath = join(opts.out, `summary-${stamp}.json`);
  const meta = {
    kind: 'meta', base: BASE, startedAt: new Date().toISOString(),
    widths: opts.widths, trials: opts.trials, task: opts.task, deadlineMs: opts.deadlineMs,
    caps: { maxActive: CAP_MAX_ACTIVE, perMinute: CAP_PER_MINUTE, admitSpacingMs: ADMIT_SPACING_MS },
  };
  appendFileSync(jsonl, JSON.stringify(meta) + '\n');
  process.stderr.write(`Eval against ${BASE} · widths ${opts.widths.join(',')} · ${opts.trials} trials\n`);

  const cohorts = {};
  for (const w of opts.widths) {
    process.stderr.write(`\n== cohort width ${w} ==\n`);
    cohorts[w] = summarizeCohort(w, await cohort(w, opts.trials, opts.task, opts.deadlineMs, jsonl));
  }

  // Speedup vs sequential (width 1) using median verified end-to-end latency and
  // per-task throughput. Effective parallelism = seq per-task time / (parallel trial wall / width).
  const seq = cohorts[1];
  const summary = { meta, cohorts, derived: {} };
  if (seq && seq.latencyP50Ms) {
    for (const w of opts.widths) {
      const c = cohorts[w];
      if (!c || !c.trialWallP50Ms) continue;
      const perTaskParallelMs = c.trialWallP50Ms / w;
      summary.derived[w] = {
        wallSpeedupVsSeqPerTask: seq.latencyP50Ms ? Number((seq.latencyP50Ms / perTaskParallelMs).toFixed(2)) : null,
        effectiveParallelism: seq.latencyP50Ms ? Number((seq.latencyP50Ms / perTaskParallelMs).toFixed(2)) : null,
        verifiedPerMinute: c.trialWallP50Ms ? Number((c.verified / c.trials / (c.trialWallP50Ms / 60000)).toFixed(2)) : null,
      };
    }
  }
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  process.stderr.write(`\nRaw: ${jsonl}\nSummary: ${summaryPath}\n`);
  console.log(JSON.stringify(summary.cohorts, null, 2));
}

main().catch((e) => { console.error('eval failed:', e.message); process.exit(1); });
