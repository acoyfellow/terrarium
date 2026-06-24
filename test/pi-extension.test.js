import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import terrariumPiExtension from '../src/pi-extension.js';
import { spawnTerrariumBackground, getRunStatus } from '../src/core.js';
import { getMailboxStatus, routeEvent, unregisterSubscriber } from '../src/router.js';

const source = readFileSync(new URL('../src/pi-extension.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function host(sessionFile) {
  const handlers = {};
  const messages = [];
  const options = [];
  const pi = {
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: () => {},
    sendMessage: (message, opts) => { messages.push(message); options.push(opts); },
  };
  const ctx = {
    hasUI: false,
    cwd: '/tmp',
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { setWidget: () => {}, notify: () => {}, theme: { fg: (_kind, value) => value } },
  };
  terrariumPiExtension(pi);
  return { handlers, messages, options, ctx };
}

async function waitUntil(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

test('package exposes Pi callback host delivery', () => {
  assert.deepEqual(pkg.pi.extensions, ['./src/pi-extension.js']);
  assert.match(source, /if \(process\.env\.TERRARIUM_RUN_ID\) return/);
  assert.match(source, /tool_result/);
  assert.match(source, /triggerTurn: true/);
  assert.match(source, /claimMailboxEvents/);
  assert.match(source, /acknowledgeMailboxEvent/);
  assert.match(source, /requeueInflightEvents/);
  assert.doesNotMatch(source, /unregisterSubscriber/);
  assert.match(source, /registerCommand\("terrarium-status"/);
  assert.match(source, /registerCommand\("terrarium-cancel"/);
  assert.match(source, /registerCommand\("terrarium-groups"/);
  assert.doesNotMatch(source, /execFile|child_process/);
});

test('real background completion wakes the Pi host exactly once', { timeout: 15000 }, async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const sessionFile = `/tmp/pi-session-${suffix}.jsonl`;
  const subscriberId = `pi_${createHash('sha256').update(sessionFile).digest('hex').slice(0, 20)}`;
  const runId = `ter_pi_e2e_${suffix}`;
  const dir = mkdtempSync(join(tmpdir(), 'terra-pi-e2e-'));
  const script = join(dir, 'child.mjs');
  writeFileSync(script, "setTimeout(() => process.exit(0), 100);\n");
  const h = host(sessionFile);
  try {
    await h.handlers.session_start({}, h.ctx);
    await spawnTerrariumBackground({ runId, task: 'Pi callback E2E', agent: `${process.execPath} ${script}`, requireTaskContract: false });
    await h.handlers.tool_result({ toolName: 'terrarium_spawn', isError: false, content: [{ type: 'text', text: JSON.stringify({ runId, background: true, status: 'running' }) }] }, h.ctx);
    await waitUntil(async () => (await getRunStatus({ runId })).status !== 'running');
    await waitUntil(async () => { await h.handlers.agent_end({}, h.ctx); return h.messages.some((m) => m.content.includes(runId)); });
    const matching = h.messages.filter((message) => message.content.includes(runId));
    assert.equal(matching.length, 1);
    assert.deepEqual(h.options.at(-1), { deliverAs: 'followUp', triggerTurn: true });
    await h.handlers.agent_end({}, h.ctx);
    assert.equal(h.messages.filter((message) => message.content.includes(runId)).length, 1);
    const mailbox = await getMailboxStatus(subscriberId);
    assert.equal(mailbox.pending, 0);
    assert.equal(mailbox.inflight, 0);
    assert.ok(mailbox.acknowledged >= 1);
  } finally {
    await h.handlers.session_shutdown({}, h.ctx).catch(() => {});
    await unregisterSubscriber(subscriberId).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi subscriber survives shutdown and surfaces an offline callback on resume', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const sessionFile = `/tmp/pi-session-${suffix}.jsonl`;
  const subscriberId = `pi_${createHash('sha256').update(sessionFile).digest('hex').slice(0, 20)}`;
  const runId = `ter_pi_resume_${suffix}`;
  const h = host(sessionFile);
  try {
    await h.handlers.session_start({}, h.ctx);
    await h.handlers.session_shutdown({}, h.ctx);
    await routeEvent({ eventId: `evt_${runId}_Completed`, type: 'Completed', runId, workflowId: runId, channel: 'test', at: new Date().toISOString(), status: 'done', ok: true, exitCode: 0 });
    assert.ok((await getMailboxStatus(subscriberId)).pending >= 1);
    await h.handlers.session_start({}, h.ctx);
    assert.equal(h.messages.filter((message) => message.content.includes(runId)).length, 1);
    assert.deepEqual(h.options.at(-1), { deliverAs: 'followUp', triggerTurn: true });
    const mailbox = await getMailboxStatus(subscriberId);
    assert.equal(mailbox.pending, 0);
    assert.equal(mailbox.inflight, 0);
    assert.ok(mailbox.acknowledged >= 1);
  } finally {
    await h.handlers.session_shutdown({}, h.ctx).catch(() => {});
    await unregisterSubscriber(subscriberId).catch(() => {});
  }
});
