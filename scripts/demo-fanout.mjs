#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnBatch } from '../src/batch.js';
import { getRunStatus } from '../src/core.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Default local demo runtime. Pi runs non-interactively with extensions enabled
// so a credentialed provider is available, and pins a reliable tool-calling
// model. `-ne` silently drops the credentialed provider and falls back to a
// weaker default whose tool calls are flaky under fan-out, so it is not used.
//
// The provider/model are supplied via env so no environment-specific or
// internal identifier is baked into this public script. Set TERRARIUM_DEMO_PROVIDER
// and TERRARIUM_DEMO_MODEL (and pass `--provider`/`--model` through your own
// wrapper) to select a reliable local model; override the whole invocation with
// `--agent` when needed.
const DEMO_PROVIDER = process.env.TERRARIUM_DEMO_PROVIDER || '';
const DEMO_MODEL = process.env.TERRARIUM_DEMO_MODEL || '';
export const DEFAULT_AGENT = [
  'pi -p --no-session',
  DEMO_PROVIDER ? `--provider ${DEMO_PROVIDER}` : '',
  DEMO_MODEL ? `--model ${DEMO_MODEL}` : '',
].filter(Boolean).join(' ');

export function parseArgs(argv) {
  const opts = { jobs: 4, compare: false, json: false, timeoutMs: 180_000, agent: DEFAULT_AGENT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compare') opts.compare = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--jobs') opts.jobs = Number(argv[++i]);
    else if (arg === '--timeout') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (arg === '--agent') opts.agent = String(argv[++i]);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(opts.jobs) || opts.jobs < 1 || opts.jobs > 4) throw new Error('--jobs must be an integer from 1 to 4');
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1_000) throw new Error('--timeout must be at least 1 second');
  return opts;
}

export async function loadTasks(count, base = root) {
  const all = JSON.parse(await readFile(join(base, 'fixtures/demo-fanout/tasks.json'), 'utf8'));
  return all.slice(0, count).map((item) => ({
    ...item,
    task: [
      `Use the read tool exactly once on the path ${item.file} (relative to the current directory).`,
      'Do not read any other file, use bash, use the network, or modify anything.',
      'The file contains one line of the form demo_fact=VALUE.',
      'Then stop and write your final answer.',
      `In your Terrarium receipt summary, include the literal token DEMO_FACT=<value>, substituting the demo_fact value you read.`,
    ].join(' '),
  }));
}

function overlapPeak(runs) {
  const events = [];
  for (const run of runs) {
    const start = Date.parse(run.startedAt || '');
    const finish = Date.parse(run.finishedAt || '');
    if (!Number.isFinite(start) || !Number.isFinite(finish)) continue;
    events.push([start, 1], [finish, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let active = 0;
  let peak = 0;
  for (const [, delta] of events) { active += delta; peak = Math.max(peak, active); }
  return peak;
}

export function summarizePhase(name, tasks, runs, wallMs) {
  const byIndex = runs.map((run, index) => {
    const expectedToken = `DEMO_FACT=${tasks[index].expected}`;
    const receiptVerified = run.taskContractStatus === 'verified';
    // The receipt summary is free-text; Terrarium only correlates
    // runId/fingerprint/nonce. The fact is a robust substring signal that the
    // real child actually read the assigned file, not a strict-equality gate.
    const factVerified = typeof run.taskResultSummary === 'string'
      && run.taskResultSummary.toUpperCase().includes(expectedToken.toUpperCase());
    const callbackVerified = /^evt_[A-Za-z0-9_]+_(?:Completed|Failed|TimedOut|Cancelled)$/.test(run.terminalCallback?.eventId || '');
    const durationMs = Math.max(0, Date.parse(run.finishedAt || '') - Date.parse(run.startedAt || '')) || 0;
    return {
      id: tasks[index].id,
      status: run.status,
      durationMs,
      receiptVerified,
      factVerified,
      callbackVerified,
      ok: run.status === 'done' && run.ok === true && receiptVerified && factVerified && callbackVerified,
    };
  });
  return {
    name,
    wallMs: Math.round(wallMs),
    sumChildDurationMs: byIndex.reduce((sum, run) => sum + run.durationMs, 0),
    peakActive: overlapPeak(runs),
    verifiedCount: byIndex.filter((run) => run.receiptVerified && run.factVerified).length,
    callbackCount: byIndex.filter((run) => run.callbackVerified).length,
    failedCount: byIndex.filter((run) => ['failed', 'error', 'cancelled'].includes(run.status)).length,
    inconclusiveCount: byIndex.filter((run) => run.status === 'inconclusive').length,
    ok: byIndex.every((run) => run.ok),
    runs: byIndex,
  };
}

async function progress(label, promise, enabled) {
  if (!enabled) return await promise;
  const started = performance.now();
  process.stdout.write(`${label} `);
  const timer = setInterval(() => {
    process.stdout.write(`\r${label} ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }, 250);
  try { return await promise; }
  finally { clearInterval(timer); process.stdout.write('\n'); }
}

async function getSettledRun(runId, waitMs = 5000) {
  const deadline = performance.now() + waitMs;
  while (true) {
    const run = await getRunStatus({ runId });
    if (run.terminalCallback?.eventId || performance.now() >= deadline) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function executeRealPhase({ name, tasks, concurrency, timeoutMs, interactive, agent = DEFAULT_AGENT }) {
  const jobs = tasks.map((item) => ({
    task: item.task,
    agent,
    profile: 'minimal',
    readOnly: true,
    cwd: root,
    isolation: 'none',
    timeoutMs,
    needsAttentionAfterMs: 60_000,
    maxDepth: 1,
    allowSpawn: false,
    requireTaskContract: true,
    channel: `demo-fanout-${name}-${item.id}`,
  }));
  const start = performance.now();
  const batch = await progress(
    `${name === 'sequential' ? 'Sequential' : 'Parallel'} phase (${tasks.length} real Pi tasks)`,
    spawnBatch({ jobs, strategy: 'allSettled', concurrency, timeoutMs, pollMs: 200, label: `Fan-out demo ${name}` }),
    interactive,
  );
  const wallMs = performance.now() - start;
  const runs = await Promise.all(batch.runIds.map((runId) => getSettledRun(runId)));
  return summarizePhase(name, tasks, runs, wallMs);
}

export function buildResult(tasks, phases) {
  const sequential = phases.find((phase) => phase.name === 'sequential') || null;
  const parallel = phases.find((phase) => phase.name === 'parallel') || null;
  const speedup = sequential && parallel && parallel.wallMs > 0 ? sequential.wallMs / parallel.wallMs : null;
  return {
    schemaVersion: 1,
    backend: 'local-terrarium',
    agentRuntime: 'pi',
    taskCount: tasks.length,
    phases,
    comparison: speedup == null ? null : {
      sequentialWallMs: sequential.wallMs,
      parallelWallMs: parallel.wallMs,
      speedup: Number(speedup.toFixed(2)),
      parallelEfficiency: Number((speedup / tasks.length).toFixed(2)),
    },
    ok: phases.length > 0 && phases.every((phase) => phase.ok),
  };
}

export function formatResult(result) {
  const lines = ['', 'Terrarium Real Pi Fan-Out', ''];
  lines.push(`Backend              ${result.backend}`);
  lines.push(`Agent runtime        ${result.agentRuntime}`);
  lines.push(`Tasks requested      ${result.taskCount}`);
  for (const phase of result.phases) {
    lines.push('');
    lines.push(`${phase.name === 'sequential' ? 'Sequential' : 'Parallel'} wall time   ${(phase.wallMs / 1000).toFixed(1)}s`);
    lines.push(`Peak active          ${phase.peakActive}`);
    lines.push(`Verified receipts    ${phase.verifiedCount}/${result.taskCount}`);
    lines.push(`Terminal callbacks   ${phase.callbackCount}/${result.taskCount}`);
  }
  if (result.comparison) {
    lines.push('');
    lines.push(`Measured speedup      ${result.comparison.speedup.toFixed(2)}x`);
    lines.push(`Parallel efficiency   ${(result.comparison.parallelEfficiency * 100).toFixed(1)}%`);
  }
  lines.push('', `${result.ok ? 'PASS' : 'FAIL'} — ${result.ok ? 'all facts, receipts, and callbacks verified' : 'one or more authoritative checks failed'}`, '');
  return lines.join('\n');
}

export async function runDemo(opts, deps = {}) {
  const tasks = await (deps.loadTasks || loadTasks)(opts.jobs);
  const execute = deps.executePhase || executeRealPhase;
  const phases = [];
  if (opts.compare) phases.push(await execute({ name: 'sequential', tasks, concurrency: 1, timeoutMs: opts.timeoutMs, interactive: !opts.json, agent: opts.agent }));
  phases.push(await execute({ name: 'parallel', tasks, concurrency: tasks.length, timeoutMs: opts.timeoutMs, interactive: !opts.json, agent: opts.agent }));
  return buildResult(tasks, phases);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  process.env.TERRARIUM_STARTUP_WATCHDOG_MS ||= '45000';
  const result = await runDemo(opts);
  process.stdout.write(opts.json ? `${JSON.stringify(result)}\n` : formatResult(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(`fan-out demo failed: ${error.message}`); process.exitCode = 1; });
}
