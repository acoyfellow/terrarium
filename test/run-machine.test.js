import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRunState, transition } from '../src/run-machine.js';
import { spawnTerrariumBackground, cancelRun, getRunStatus } from '../src/core.js';
import { registerSubscriber, claimMailboxEvents, unregisterSubscriber } from '../src/router.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayScheduleFile, replayScheduleFixture } from '../src/schedule-replay.js';

const cancel = { type: 'CancelRequested' };
const exited = { type: 'ChildExited', exitCode: 0 };
const receipt = { type: 'ReceiptObserved', status: 'verified', summary: 'done' };

function replay(inputs, options) {
  let state = initialRunState(options);
  const decisions = [];
  for (const input of inputs) {
    const step = transition(state, input);
    state = step.state;
    decisions.push(...step.decisions);
  }
  return { state, decisions };
}
function count(result, type) { return result.decisions.filter((d) => d.type === type).length; }
function assertSingleTerminal(result) {
  assert.ok(count(result, 'Finalize') <= 1, 'at most one terminal result');
  assert.ok(count(result, 'QueueCallback') <= 1, 'at most one completion callback');
  assert.equal(count(result, 'Finalize'), count(result, 'QueueCallback'), 'terminal result and callback are paired');
}

test('CancelRequested -> ChildExited -> ReceiptObserved: cancellation wins once', () => {
  const r = replay([cancel, exited, receipt]);
  assert.equal(r.state.terminal.status, 'cancelled');
  assert.equal(r.state.terminal.taskContractStatus, 'not-applicable');
  assert.equal(count(r, 'Finalize'), 1);
  assert.equal(count(r, 'QueueCallback'), 1);
  assert.ok(r.decisions.some((d) => d.type === 'IgnoreLateInput' && d.inputType === 'ReceiptObserved'));
  assertSingleTerminal(r);
});

test('ChildExited -> ReceiptObserved -> CancelRequested: completion wins once', () => {
  const r = replay([exited, receipt, cancel]);
  assert.equal(r.state.terminal.status, 'done');
  assert.equal(count(r, 'Finalize'), 1);
  assert.equal(count(r, 'QueueCallback'), 1);
  assert.ok(r.decisions.some((d) => d.type === 'IgnoreLateInput' && d.inputType === 'CancelRequested'));
  assertSingleTerminal(r);
});

test('exit waits for receipt classification instead of trusting process success', () => {
  const afterExit = replay([exited]);
  assert.equal(afterExit.state.phase, 'running');
  assert.equal(count(afterExit, 'Finalize'), 0);
  const missing = replay([exited, { type: 'ReceiptObserved', status: 'missing' }]);
  assert.equal(missing.state.terminal.status, 'inconclusive');
  assert.equal(missing.state.terminal.ok, false);
});

test('deadline is virtual and immediate; no timer or sleep required', () => {
  const r = replay([{ type: 'DeadlineReached' }, { type: 'ProcessTerminated' }, { type: 'ChildExited', exitCode: 128, signal: 'SIGTERM' }], { requireReceipt: false });
  assert.equal(r.state.terminal.status, 'failed');
  assert.equal(r.state.terminal.reason, 'deadline-reached');
  assert.ok(r.decisions.some((d) => d.type === 'TerminateChild'));
  assertSingleTerminal(r);
});

test('terminal commit makes the cancel-versus-completion boundary explicit', () => {
  // Cancellation wins only when CancelRequested is observed before terminal
  // commit; a request observed after commit is explicitly ignored.
  assert.equal(replay([cancel, exited, receipt]).state.terminal.status, 'cancelled');
  assert.equal(replay([exited, receipt, cancel]).state.terminal.status, 'done');
});

test('real background cancel emits exactly one terminal callback', { timeout: 15000 }, async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const runId = `ter_machine_${suffix}`;
  const subscriberId = `sub_machine_${suffix}`;
  const dir = mkdtempSync(join(tmpdir(), 'terra-machine-adapter-'));
  const script = join(dir, 'slow.mjs');
  writeFileSync(script, `setInterval(()=>{},1000);`);
  await registerSubscriber({ subscriberId, runIds: [runId], eventTypes: ['*'], channels: ['*'], workflowIds: ['*'] });
  try {
    await spawnTerrariumBackground({ runId, task: 'machine adapter cancellation', agent: `${process.execPath} ${script}`, requireTaskContract: false });
    await cancelRun({ runId });
    let status;
    for (let i = 0; i < 80; i++) {
      status = await getRunStatus({ runId, staleMs: 1000 });
      if (status.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.status, 'cancelled');
    let terminal = [];
    for (let i = 0; i < 40; i++) {
      const claimed = await claimMailboxEvents({ subscriberId, limit: 20 });
      terminal.push(...claimed.events.filter((event) => event.runId === runId && ['Completed', 'Failed', 'Cancelled', 'TimedOut'].includes(event.type)));
      if (terminal.length) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].type, 'Cancelled');
  } finally {
    await unregisterSubscriber({ subscriberId }).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('versioned cancellation/completion schedules replay portably', async () => {
  for (const [file, expected] of [['cancel-before-completion.v1.json', 'cancelled'], ['completion-before-cancel.v1.json', 'done']]) {
    const result = await replayScheduleFile(join(process.cwd(), 'fixtures', 'run-schedules', file));
    assert.equal(result.ok, true);
    assert.equal(result.terminal.status, expected);
    assert.equal(result.terminalCount, 1);
    assert.equal(result.callbackCount, 1);
  }
});

test('schedule fixtures are bounded and reject private fields', () => {
  assert.throws(() => replayScheduleFixture({ version: 1, id: 'bad', affectedRevision: 'fa4fba0', initialState: { requireReceipt: true }, orderedInputs: [{ type: 'ReceiptObserved', status: 'verified', summary: 'private output' }], invariants: ['at-most-one-terminal'] }), /private or unsupported/);
});

test('seeded bounded permutations preserve single-terminal and single-callback invariants', () => {
  for (const seed of [1, 7, 42, 1337, 65537]) {
    const random = mulberry32(seed);
    for (let i = 0; i < 250; i++) {
      const events = [
        cancel,
        exited,
        receipt,
        { type: 'DeadlineReached' },
        { type: 'ProcessTerminated' },
        { type: 'ChildExited', exitCode: 1 },
        { type: 'ReceiptObserved', status: 'missing' },
      ];
      const length = 2 + Math.floor(random() * 6);
      const schedule = Array.from({ length }, () => events[Math.floor(random() * events.length)]);
      const r = replay(schedule);
      assertSingleTerminal(r);
    }
  }
});

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
