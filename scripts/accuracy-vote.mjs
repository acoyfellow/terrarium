#!/usr/bin/env node
// C3/C4 accuracy-via-parallelism: self-consistency voting. Runs N independent
// attempts per task (fan-out), takes the majority-normalized answer, and scores
// correctness vs verified ground truth. Reports single-run vs voted false-trust
// so we can plot the trust-vs-fan-out curve. Free/local (pi provider path).
//
// This is an ADVISORY correctness mechanism; it never touches provenance
// (runId+taskFingerprint+nonce) authority. A vote with no majority is UNKNOWN
// (fail closed), never guessed.
//
// Usage:
//   node scripts/accuracy-vote.mjs --provider <provider> \
//     --model <model> --fixture fixtures/accuracy-bench/tasks-hard.json \
//     --n 3 --out artifacts/accuracy-bench

import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const o = { provider: '', model: '', n: 3, fixture: 'fixtures/accuracy-bench/tasks-hard.json', out: 'artifacts/accuracy-bench', timeoutMs: 90000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') o.provider = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--n') o.n = Number(argv[++i]);
    else if (a === '--fixture') o.fixture = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]) * 1000;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(o.n) || o.n < 1 || o.n > 9) throw new Error('--n 1..9');
  return o;
}

function normalize(s) { return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function correct(ansText, task) {
  const got = normalize(ansText); const want = normalize(task.expected);
  return got.includes(want);
}

function runPi({ provider, model, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    const args = ['-p', '--no-session'];
    if (provider) args.push('--provider', provider);
    if (model) args.push('--model', model);
    args.push('--no-tools', prompt);
    const child = spawn('pi', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out: '' }); });
  });
}

// Majority vote over normalized answers. Returns { answer, votes, total,
// decisive } where decisive=false means no strict majority (fail closed).
function majority(answers) {
  const counts = new Map();
  for (const a of answers) { const k = normalize(a); if (!k) continue; counts.set(k, (counts.get(k) || 0) + 1); }
  let best = null, bestN = 0, tie = false;
  for (const [k, n] of counts) { if (n > bestN) { best = k; bestN = n; tie = false; } else if (n === bestN) tie = true; }
  const decisive = best != null && bestN > answers.length / 2 && !tie;
  // pick a representative raw answer for the winning normalized key
  const raw = answers.find((a) => normalize(a) === best) ?? '';
  return { answerRaw: raw, answerKey: best, votes: bestN, total: answers.length, decisive };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const bench = JSON.parse(readFileSync(join(root, o.fixture), 'utf8'));
  mkdirSync(join(root, o.out), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonl = join(root, o.out, `vote-${o.model || 'default'}-n${o.n}-${stamp}.jsonl`);
  const label = `${o.provider || 'default'}/${o.model || 'default'}`;

  let singleCorrect = 0, votedCorrect = 0, votedUnknown = 0, votedWrong = 0, tasks = 0;
  for (const task of bench.tasks) {
    tasks++;
    const attempts = [];
    for (let i = 0; i < o.n; i++) { const r = await runPi({ ...o, prompt: task.prompt }); attempts.push(r.out); }
    // single-run baseline = first attempt
    const singleOk = correct(attempts[0], task);
    if (singleOk) singleCorrect++;
    const m = majority(attempts);
    let votedOutcome;
    if (!m.decisive) { votedUnknown++; votedOutcome = 'unknown'; }
    else if (correct(m.answerRaw, task)) { votedCorrect++; votedOutcome = 'correct'; }
    else { votedWrong++; votedOutcome = 'wrong'; }
    const rec = { id: task.id, class: task.class, n: o.n, model: label, expected: task.expected, attempts: attempts.map((a) => a.slice(0, 40)), single: singleOk ? 'correct' : 'wrong', vote: { ...m, outcome: votedOutcome } };
    appendFileSync(jsonl, JSON.stringify(rec) + '\n');
    process.stderr.write(`  ${task.id}: single=${singleOk ? 'OK' : 'XX'} voted=${votedOutcome} (${m.votes}/${m.total})\n`);
  }
  const summary = {
    model: label, n: o.n, tasks,
    singleRun: { correct: singleCorrect, falseTrust: Number(((tasks - singleCorrect) / tasks).toFixed(3)) },
    // Voted false-trust = wrong-but-decisive / tasks. Unknown is NOT false trust
    // (it fails closed: no confident answer, so no false trust).
    voted: { correct: votedCorrect, wrong: votedWrong, unknown: votedUnknown, falseTrust: Number((votedWrong / tasks).toFixed(3)), decisiveRate: Number(((votedCorrect + votedWrong) / tasks).toFixed(3)) },
  };
  writeFileSync(join(root, o.out, `vote-summary-${o.model || 'default'}-n${o.n}-${stamp}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error('accuracy-vote failed:', e.message); process.exit(1); });
