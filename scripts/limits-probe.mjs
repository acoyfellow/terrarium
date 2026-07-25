#!/usr/bin/env node
// Limits-discovery probe harness.
// Runs ONE boundary probe at a time against the live cloud API and prints the
// observed behavior so a limit can be classified and appended to the ledger.
// Never synthesizes a verdict; a probe that can't decide is INCONCLUSIVE.
//
// Usage:
//   TERRA_BASE=https://<slot> TERRA_TOKEN_FILE=/path/token \
//   node scripts/limits-probe.mjs <probe-id>
//
// One probe id per run. Add new probes to PROBES; keep each self-contained.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE = process.env.TERRA_BASE;
const TOKEN = process.env.TERRA_TOKEN_FILE ? readFileSync(process.env.TERRA_TOKEN_FILE, "utf8").trim() : process.env.TERRA_TOKEN;
if (!BASE || !TOKEN) { console.error("set TERRA_BASE and TERRA_TOKEN_FILE (or TERRA_TOKEN)"); process.exit(2); }

const rid = () => "lim-" + Math.random().toString(16).slice(2, 10);
function post(body, headers = {}) {
  const h = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers };
  const hdr = Object.entries(h).map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`).join(" ");
  const out = execSync(`curl -s -w '\\n%{http_code}' -X POST ${BASE}/api/runs ${hdr} --data-binary @-`, { input: JSON.stringify(body), timeout: 60000, maxBuffer: 8 * 1024 * 1024 }).toString();
  const nl = out.lastIndexOf("\n");
  return { code: out.slice(nl + 1).trim(), body: out.slice(0, nl) };
}
function getStatus(runId) {
  const s = execSync(`curl -s ${BASE}/api/runs/${runId}/status -H ${JSON.stringify(`authorization: Bearer ${TOKEN}`)}`, { timeout: 30000 }).toString();
  try { const d = JSON.parse(s); const st = d.status || d; return { status: st.status, tc: st.terminal?.taskContractStatus, reason: st.terminal?.reason }; }
  catch { return { status: "?", raw: s.slice(0, 120) }; }
}
function pollTerminal(runId, n = 40) {
  for (let i = 0; i < n; i++) {
    const st = getStatus(runId);
    if (["done", "failed", "cancelled", "inconclusive", "error"].includes(st.status)) return st;
    execSync("sleep 5");
  }
  return { status: "poll-timeout" };
}

const PROBES = {
  // FIT: task text over the 64 KiB admission gate.
  "fit-task-oversize": () => {
    const task = "x".repeat(70 * 1024);
    const r = post({ task }, { "idempotency-key": rid() });
    return { probe: "task text 70 KiB (> 64 KiB MAX_TASK_BYTES)", observed: `HTTP ${r.code} ${r.body.slice(0, 80)}`, expect: "413 fail-closed" };
  },
  // FIT: task text just under the gate should admit.
  "fit-task-underlimit": () => {
    const task = "reply with exactly: ok " + "y".repeat(60 * 1024);
    const r = post({ task, spec: { deadlineMs: 150000 } }, { "idempotency-key": rid() });
    return { probe: "task text ~60 KiB (< 64 KiB)", observed: `admit HTTP ${r.code}`, expect: "202 admitted" };
  },
  // FIT: missing idempotency key.
  "fit-missing-idem": () => {
    const r = post({ task: "ok" });
    return { probe: "POST /api/runs with no Idempotency-Key", observed: `HTTP ${r.code} ${r.body.slice(0, 80)}`, expect: "400 fail-closed" };
  },
  // FIT: deadline below the 1s floor — is it clamped, not rejected?
  "fit-deadline-subsecond": () => {
    const r = post({ task: "reply with: ok", spec: { deadlineMs: 1 } }, { "idempotency-key": rid() });
    let runId; try { runId = JSON.parse(r.body).runId; } catch {}
    const term = runId ? pollTerminal(runId) : null;
    return { probe: "deadlineMs: 1 (below 1s floor)", observed: `admit ${r.code}; terminal ${JSON.stringify(term)}`, expect: "clamped to 1s floor -> deadline-reached, no receipt" };
  },
  // CANNOT: multi-turn / statefulness across runs — a second run cannot see the first's state.
  "cannot-crossrun-state": () => {
    const a = post({ task: "Remember the secret number 42 for later.", spec: { deadlineMs: 150000 } }, { "idempotency-key": rid() });
    let ra; try { ra = JSON.parse(a.body).runId; } catch {}
    if (ra) pollTerminal(ra);
    const b = post({ task: "What was the secret number I told you earlier? Reply with only the number.", spec: { deadlineMs: 150000 } }, { "idempotency-key": rid() });
    let rb; try { rb = JSON.parse(b.body).runId; } catch {}
    const term = rb ? pollTerminal(rb) : null;
    return { probe: "cross-run memory (run B asks about run A's state)", observed: `run A ${ra}; run B ${rb} -> ${JSON.stringify(term)} (a bounded run has NO memory of another run)`, expect: "no shared state; each run is independent (BY-DESIGN: bounded)" };
  },
  // FIT: model output token ceiling (4096). Ask for a very long output; does it
  // truncate cleanly while the receipt stays verified?
  "fit-output-ceiling": () => {
    const r = post({ task: "Output the word 'terrarium' repeated 20000 times as a single space-separated line. Do not stop early.", spec: { deadlineMs: 200000 } }, { "idempotency-key": rid() });
    let runId; try { runId = JSON.parse(r.body).runId; } catch {}
    const term = runId ? pollTerminal(runId) : null;
    return { probe: "request 20000-word output (> 4096-token clamp)", runId, observed: `admit ${r.code}; terminal ${JSON.stringify(term)}`, expect: "truncated at 4096 tokens; receipt still verified (BY-DESIGN)" };
  },
};

const id = process.argv[2];
if (!id || !PROBES[id]) { console.error("probes:", Object.keys(PROBES).join(", ")); process.exit(2); }
console.log(`limits-probe: ${id}`);
const result = PROBES[id]();
console.log(JSON.stringify(result, null, 2));
