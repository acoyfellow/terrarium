import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import terrariumPiExtension from '../src/pi-extension.js';
import { getMailboxStatus, routeEvent, unregisterSubscriber } from '../src/router.js';

const source = readFileSync(new URL('../src/pi-extension.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package exposes a thin Pi-native Terrarium presentation extension', () => {
  assert.deepEqual(pkg.pi.extensions, ['./src/pi-extension.js']);
  assert.match(source, /if \(process\.env\.TERRARIUM_RUN_ID\) return/);
  assert.match(source, /setWidget\(WIDGET/);
  assert.match(source, /claimMailboxEvents/);
  assert.match(source, /acknowledgeMailboxEvent/);
  assert.match(source, /requeueInflightEvents/);
  assert.doesNotMatch(source, /unregisterSubscriber/);
  assert.match(source, /registerCommand\("terrarium-status"/);
  assert.match(source, /registerCommand\("terrarium-cancel"/);
  assert.match(source, /registerCommand\("terrarium-groups"/);
  assert.match(source, /getRunGroupStatus/);
  assert.doesNotMatch(source, /spawn\(|execFile|child_process/);
});

test('Pi subscriber survives shutdown and delivers a callback on session resume', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const sessionFile = `/tmp/pi-session-${suffix}.jsonl`;
  const subscriberId = `pi_${createHash('sha256').update(sessionFile).digest('hex').slice(0, 20)}`;
  const runId = `ter_pi_resume_${suffix}`;
  const handlers = {};
  const messages = [];
  const pi = {
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: () => {},
    sendMessage: (message) => { messages.push(message); },
  };
  const ctx = {
    hasUI: false,
    cwd: '/tmp',
    sessionManager: { getSessionFile: () => sessionFile },
    ui: { setWidget: () => {}, notify: () => {}, theme: { fg: (_kind, value) => value } },
  };
  terrariumPiExtension(pi);
  try {
    await handlers.session_start({}, ctx);
    await handlers.session_shutdown({}, ctx);
    await routeEvent({ eventId: `evt_${runId}_Completed`, type: 'Completed', runId, workflowId: runId, channel: 'test', at: new Date().toISOString(), status: 'done', ok: true, exitCode: 0 });
    assert.ok((await getMailboxStatus(subscriberId)).pending >= 1);
    await handlers.session_start({}, ctx);
    const matching = messages.filter((message) => message.content.includes(runId));
    assert.equal(matching.length, 1);
    const mailbox = await getMailboxStatus(subscriberId);
    assert.equal(mailbox.pending, 0);
    assert.equal(mailbox.inflight, 0);
    assert.ok(mailbox.acknowledged >= 1);
  } finally {
    await handlers.session_shutdown({}, ctx).catch(() => {});
    await unregisterSubscriber(subscriberId).catch(() => {});
  }
});
