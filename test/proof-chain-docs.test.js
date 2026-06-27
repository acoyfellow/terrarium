import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(root + 'README.md', 'utf8');
const changelog = readFileSync(root + 'CHANGELOG.md', 'utf8');
const publicChangelog = readFileSync(root + 'app/public/CHANGELOG.md', 'utf8');

test('README names a single authoritative success proof chain', () => {
  assert.match(readme, /## Authoritative success proof/);
  assert.match(readme, /child exits 0\s*\+\s*verified TERRARIUM_RESULT receipt/);
  assert.match(readme, /Exit 0 alone is never success/);
});

test('README explicitly disclaims the four confusable surfaces as proof', () => {
  const section = readme.slice(readme.indexOf('## Authoritative success proof'));
  for (const surface of ['Callbacks', 'Groups', 'public run ledger', 'CHANGELOG.md']) {
    assert.ok(section.includes(surface), `proof section must address ${surface}`);
  }
  assert.match(section, /not\b[^\n]*authoritative success proof/i);
});

test('MCP tool descriptions carry the not-proof disclaimer inline', () => {
  assert.match(readme, /terminal callback is a notification[^\n]*not authoritative proof/i);
  assert.match(readme, /Group state is a fail-closed roll-up[^\n]*not independent success proof/i);
});

test('adoption metrics are not labeled as success proof', () => {
  assert.ok(!/## Proof of the original primitive/.test(readme), 'adoption heading must not say "Proof"');
  assert.match(readme, /## Adoption signal for the original primitive/);
});

test('CHANGELOG records the proof-chain doc change and public copy mirrors exactly', () => {
  assert.match(changelog, /one authoritative success proof, not four/i);
  assert.equal(changelog, publicChangelog, 'app/public/CHANGELOG.md must mirror CHANGELOG.md exactly');
});
