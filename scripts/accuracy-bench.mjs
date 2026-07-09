#!/usr/bin/env node
// C1 accuracy baseline: measure single-run CORRECTNESS (answer matches ground
// truth), reported SEPARATELY from provenance (which the receipt already
// covers). This is the intake for the accuracy-trust-scale loop.
//
// Local mode (default): runs the real Pi runtime directly (no cloud cost),
// pinning a provider/model, so we can measure correctness across models for
// free. It does NOT touch receipts/provenance — this tool answers only "is the
// answer right?". Provenance authority is unchanged and untouched.
//
// Usage:
//   node scripts/accuracy-bench.mjs --provider <provider> \
//       --model <model> --trials 1 --out artifacts/accuracy-bench
//
// Scoring is machine-checkable per fixtures/accuracy-bench/tasks.json.

import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const o = { provider: '', model: '', trials: 1, out: 'artifacts/accuracy-bench', timeoutMs: 90000, fixture: 'fixtures/accuracy-bench/tasks.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider') o.provider = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--trials') o.trials = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--timeout') o.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--fixture') o.fixture = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(o.trials) || o.trials < 1 || o.trials > 20) throw new Error('trials 1..20');
  return o;
}

function normalize(s) { return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function score(answerText, task) {
  const ans = String(answerText ?? '');
  if (task.check === 'regex') {
    try { return new RegExp(task.expected, 'i').test(ans); } catch { return false; }
  }
  // exact: normalized expected token must appear as a normalized token in the
  // answer (tolerant of surrounding words/punctuation, strict on the value).
  const want = normalize(task.expected);
  const got = normalize(ans);
  return got.includes(want);
}

function runPi({ provider, model, prompt, timeoutMs }) {
  return new Promise((resolve) => {
    const args = ['-p', '--no-session'];
    if (provider) args.push('--provider', provider);
    if (model) args.push('--model', model);
    args.push('--no-tools', prompt);
    const child = spawn('pi', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: '', err: String(e.message || e) }); });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const bench = JSON.parse(readFileSync(join(root, opts.fixture), 'utf8'));
  mkdirSync(join(root, opts.out), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonl = join(root, opts.out, `raw-${opts.model || 'default'}-${stamp}.jsonl`);
  const label = `${opts.provider || 'default'}/${opts.model || 'default'}`;

  const results = [];
  for (const task of bench.tasks) {
    for (let t = 0; t < opts.trials; t++) {
      const r = await runPi({ provider: opts.provider, model: opts.model, prompt: task.prompt, timeoutMs: opts.timeoutMs });
      const correct = r.code === 0 && score(r.out, task);
      const rec = { id: task.id, class: task.class, trial: t, model: label, expected: task.expected, answer: r.out.slice(0, 200), correct, exit: r.code };
      appendFileSync(jsonl, JSON.stringify(rec) + '\n');
      results.push(rec);
      process.stderr.write(`  ${task.id} t${t}: ${correct ? 'OK ' : 'XX '} expected=${task.expected} got=${JSON.stringify(r.out.slice(0, 40))}\n`);
    }
  }
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const byClass = {};
  for (const r of results) { (byClass[r.class] ??= { total: 0, correct: 0 }); byClass[r.class].total++; if (r.correct) byClass[r.class].correct++; }
  const summary = { model: label, trials: opts.trials, total, correct, accuracy: total ? Number((correct / total).toFixed(3)) : 0, byClass };
  writeFileSync(join(root, opts.out, `summary-${opts.model || 'default'}-${stamp}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error('accuracy-bench failed:', e.message); process.exit(1); });
