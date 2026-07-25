import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResult, DEFAULT_AGENT, formatResult, parseArgs, runDemo, summarizePhase } from '../scripts/demo-fanout.mjs';

const tasks = [
  { id: 'a', expected: 'alpha' },
  { id: 'b', expected: 'beta' },
];

function run(index, overrides = {}) {
  const task = tasks[index];
  return {
    runId: `ter_demo_${index}`,
    status: 'done',
    ok: true,
    taskContractStatus: 'verified',
    taskResultSummary: `read the file and confirmed DEMO_FACT=${task.expected} as required`,
    terminalCallback: { eventId: `evt_ter_demo_${index}_Completed` },
    startedAt: `2026-01-01T00:00:0${index}.000Z`,
    finishedAt: `2026-01-01T00:00:0${index + 2}.000Z`,
    ...overrides,
  };
}

test('demo args are bounded and comparison is opt-in', () => {
  assert.deepEqual(parseArgs(['--jobs', '3', '--compare', '--json', '--timeout', '90']), {
    jobs: 3, compare: true, json: true, timeoutMs: 90_000, agent: DEFAULT_AGENT,
  });
  assert.equal(parseArgs(['--agent', 'pi -p']).agent, 'pi -p');
  assert.throws(() => parseArgs(['--jobs', '5']), /1 to 4/);
  assert.throws(() => parseArgs(['--wat']), /unknown option/);
});

test('phase summary requires status, receipt, expected fact, and canonical callback', () => {
  const phase = summarizePhase('parallel', tasks, [run(0), run(1)], 2500);
  assert.equal(phase.ok, true);
  assert.equal(phase.verifiedCount, 2);
  assert.equal(phase.callbackCount, 2);
  assert.equal(phase.peakActive, 2);

  const broken = summarizePhase('parallel', tasks, [run(0), run(1, { taskResultSummary: 'DEMO_FACT=nope' })], 2500);
  assert.equal(broken.ok, false);
  assert.equal(broken.verifiedCount, 1);
});

test('comparison derives speedup and efficiency only from measured phase times', () => {
  const sequential = summarizePhase('sequential', tasks, [run(0), run(1, {
    startedAt: '2026-01-01T00:00:02.000Z',
    finishedAt: '2026-01-01T00:00:04.000Z',
  })], 8000);
  const parallel = summarizePhase('parallel', tasks, [run(0), run(1)], 2500);
  const result = buildResult(tasks, [sequential, parallel]);
  assert.deepEqual(result.comparison, {
    sequentialWallMs: 8000,
    parallelWallMs: 2500,
    speedup: 3.2,
    parallelEfficiency: 1.6,
  });
  assert.equal(result.ok, true);
  assert.match(formatResult(result), /Measured speedup\s+3\.20x/);
  assert.match(formatResult(result), /PASS/);
});

test('runDemo gives sequential and parallel phases the identical task objects', async () => {
  const seen = [];
  const result = await runDemo(
    { jobs: 2, compare: true, json: true, timeoutMs: 1000 },
    {
      loadTasks: async () => tasks,
      executePhase: async ({ name, tasks: received, concurrency }) => {
        seen.push({ name, received, concurrency });
        return summarizePhase(name, received, [run(0), run(1)], name === 'sequential' ? 4000 : 2000);
      },
    },
  );
  assert.equal(seen[0].received, seen[1].received);
  assert.deepEqual(seen.map(({ name, concurrency }) => ({ name, concurrency })), [
    { name: 'sequential', concurrency: 1 },
    { name: 'parallel', concurrency: 2 },
  ]);
  assert.equal(result.ok, true);
});
