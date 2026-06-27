import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectMistypedCommand,
  editDistance,
  KNOWN_COMMANDS,
  KNOWN_SUBCOMMANDS,
} from '../src/command-guard.js';

test('editDistance computes Levenshtein distance', () => {
  assert.equal(editDistance('status', 'status'), 0);
  assert.equal(editDistance('statsu', 'status'), 2);
  assert.equal(editDistance('', 'read'), 4);
  assert.equal(editDistance('heal', ''), 4);
  assert.equal(editDistance('group', 'troup'), 1);
  assert.equal(editDistance('group', 'gruop'), 2);
});

test('exact top-level command with no required subcommand is not a typo', () => {
  assert.equal(detectMistypedCommand(['status']), null);
  assert.equal(detectMistypedCommand(['status', 'ter_abc']), null);
  assert.equal(detectMistypedCommand(['doctor']), null);
});

test('prose tasks are never treated as command typos', () => {
  assert.equal(detectMistypedCommand(['Fix', 'the', 'login', 'bug']), null);
  assert.equal(detectMistypedCommand(['summarize', 'the', 'failing', 'test']), null);
  // Multi-word first token shape (with spaces) cannot look like a command verb.
  assert.equal(detectMistypedCommand(['status of the migration']), null);
});

test('empty or non-array input returns null', () => {
  assert.equal(detectMistypedCommand([]), null);
  assert.equal(detectMistypedCommand(null), null);
  assert.equal(detectMistypedCommand(undefined), null);
});

test('near-miss top-level command suggests the closest command', () => {
  const r = detectMistypedCommand(['statsu']);
  assert.equal(r?.kind, 'command');
  assert.equal(r.suggestion, 'status');
  assert.match(r.message, /unknown command "statsu"/);
  assert.match(r.message, /terra status/);
  assert.match(r.message, /--task/);
});

test('unrelated unknown first token is left to the dispatcher (treated as task)', () => {
  // "deploy" is not close to any known command, so it should run as a task.
  assert.equal(detectMistypedCommand(['deploy']), null);
});

test('reserved verb with a missing subcommand fails closed', () => {
  for (const [verb, subs] of Object.entries(KNOWN_SUBCOMMANDS)) {
    const r = detectMistypedCommand([verb]);
    assert.equal(r?.kind, 'subcommand', `${verb} should require a subcommand`);
    assert.equal(r.input, null);
    for (const sub of subs) assert.match(r.message, new RegExp(sub.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
    assert.match(r.message, /needs a subcommand/);
  }
});

test('reserved verb with an unknown non-typo subcommand fails closed and lists valid options', () => {
  const r = detectMistypedCommand(['group', 'frobnicate', 'xyz']);
  assert.equal(r?.kind, 'subcommand');
  assert.equal(r.command, 'group');
  assert.equal(r.input, 'frobnicate');
  assert.equal(r.suggestion, null);
  assert.match(r.message, /unknown subcommand "group frobnicate"/);
  assert.match(r.message, /Valid: create, status, read/);
});

test('reserved verb with a near-miss subcommand suggests the closest subcommand', () => {
  const r = detectMistypedCommand(['group', 'statuss', 'abc']);
  assert.equal(r?.kind, 'subcommand');
  assert.equal(r.suggestion, 'status');
  assert.match(r.message, /Did you mean "group status"/);
});

test('schedule run is corrected, not silently spawned', () => {
  const r = detectMistypedCommand(['schedule', 'run', 'foo.json']);
  assert.equal(r?.kind, 'subcommand');
  assert.match(r.message, /unknown subcommand "schedule run"/);
  assert.match(r.message, /Valid: replay/);
});

test('every valid subcommand of every reserved verb passes through', () => {
  for (const [verb, subs] of Object.entries(KNOWN_SUBCOMMANDS)) {
    for (const sub of subs) {
      assert.equal(detectMistypedCommand([verb, sub, 'arg']), null, `${verb} ${sub} should be valid`);
    }
  }
});

test('every known command verb is recognized as exact', () => {
  for (const cmd of KNOWN_COMMANDS) {
    if (KNOWN_SUBCOMMANDS[cmd]) continue; // covered by subcommand tests
    assert.equal(detectMistypedCommand([cmd]), null, `${cmd} should be exact`);
  }
});
