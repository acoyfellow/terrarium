#!/usr/bin/env node
// C4: cross-MODEL agreement. Self-consistency (N copies of one model) cannot
// catch systematic bias. This runs the SAME task across DIFFERENT models and
// scores agreement: if diverse models independently agree, systematic single-
// model errors should surface as disagreement -> UNKNOWN (fail closed) rather
// than confident-wrong. Advisory only; provenance untouched.
//
// Usage:
//   node scripts/accuracy-cross-model.mjs \
//     --provider <provider> \
//     --models <modelA>,<modelB>,<modelC> \
//     --fixture fixtures/accuracy-bench/tasks-hard.json --out artifacts/accuracy-bench

import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const o = { provider: '', models: [], fixture: 'fixtures/accuracy-bench/tasks-hard.json', out: 'artifacts/accuracy-bench', timeoutMs: 90000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') o.provider = argv[++i];
    else if (a === '--models') o.models = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--fixture') o.fixture = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--gate') o.gate = argv[++i]; // 'unanimous' (default) or 'majority'
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.models.length < 2) throw new Error('--models needs >=2 distinct models');
  o.gate = o.gate || 'unanimous';
  if (!['unanimous', 'majority'].includes(o.gate)) throw new Error('--gate unanimous|majority');
  return o;
}

function normalize(s) { return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function correct(t, task) { return normalize(t).includes(normalize(task.expected)); }

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
    child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

// Agreement gate. 'unanimous': every model's normalized answer must match (any
// disagreement -> UNKNOWN). 'majority': a strict >half agreement wins; ties or
// no-majority -> UNKNOWN. Both fail closed; unanimous trades coverage for the
// lowest false-trust, majority raises coverage at some false-trust risk.
function agree(answers, gate) {
  const keys = answers.map(normalize).filter(Boolean);
  if (keys.length !== answers.length) return { decisive: false, reason: 'empty-answer' };
  if (gate === 'unanimous') {
    const first = keys[0];
    const unanimous = keys.every((k) => k === first);
    return { decisive: unanimous, key: first, raw: answers[0] };
  }
  // majority
  const counts = new Map();
  for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
  let best = null, bestN = 0, tie = false;
  for (const [k, n] of counts) { if (n > bestN) { best = k; bestN = n; tie = false; } else if (n === bestN) tie = true; }
  const decisive = best != null && bestN > answers.length / 2 && !tie;
  const raw = answers.find((a) => normalize(a) === best) ?? '';
  return { decisive, key: best, raw };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const bench = JSON.parse(readFileSync(join(root, o.fixture), 'utf8'));
  mkdirSync(join(root, o.out), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonl = join(root, o.out, `crossmodel-${stamp}.jsonl`);

  let correctDecisive = 0, wrongDecisive = 0, unknown = 0, tasks = 0;
  for (const task of bench.tasks) {
    tasks++;
    const answers = [];
    for (const m of o.models) answers.push(await runPi({ provider: o.provider, model: m, prompt: task.prompt, timeoutMs: o.timeoutMs }));
    const a = agree(answers, o.gate);
    let outcome;
    if (!a.decisive) { unknown++; outcome = 'unknown'; }
    else if (correct(a.raw, task)) { correctDecisive++; outcome = 'correct'; }
    else { wrongDecisive++; outcome = 'wrong'; }
    const rec = { id: task.id, class: task.class, models: o.models, expected: task.expected, answers: answers.map((x) => x.slice(0, 40)), outcome };
    appendFileSync(jsonl, JSON.stringify(rec) + '\n');
    process.stderr.write(`  ${task.id}: ${outcome}  [${answers.map((x) => JSON.stringify(x.slice(0, 18))).join(' ')}]\n`);
  }
  const summary = {
    models: o.models, gate: o.gate, tasks,
    // false-trust = confidently-wrong / tasks. unknown fails closed (not false trust).
    result: { correct: correctDecisive, wrong: wrongDecisive, unknown, falseTrust: Number((wrongDecisive / tasks).toFixed(3)), coverage: Number(((correctDecisive + wrongDecisive) / tasks).toFixed(3)) },
  };
  writeFileSync(join(root, o.out, `crossmodel-summary-${stamp}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error('cross-model failed:', e.message); process.exit(1); });
