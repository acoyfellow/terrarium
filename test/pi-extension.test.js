import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/pi-extension.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package exposes a thin Pi-native Terrarium presentation extension', () => {
  assert.deepEqual(pkg.pi.extensions, ['./src/pi-extension.js']);
  assert.match(source, /if \(process\.env\.TERRARIUM_RUN_ID\) return/);
  assert.match(source, /setWidget\(WIDGET/);
  assert.match(source, /claimMailboxEvents/);
  assert.match(source, /acknowledgeMailboxEvent/);
  assert.match(source, /registerCommand\("terrarium-status"/);
  assert.match(source, /registerCommand\("terrarium-cancel"/);
  assert.match(source, /registerCommand\("terrarium-groups"/);
  assert.match(source, /getRunGroupStatus/);
  assert.doesNotMatch(source, /spawn\(|execFile|child_process/);
});
