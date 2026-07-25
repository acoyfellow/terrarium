import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runnerSource = readFileSync(join(root, 'scripts/terrarium-runner'), 'utf8');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'terrarium-runner-ca-'));
  const workspace = join(dir, 'workspace');
  const etc = join(dir, 'etc');
  mkdirSync(workspace);
  mkdirSync(etc);
  writeFileSync(join(workspace, 'task'), 'task');
  writeFileSync(join(workspace, 'contract'), JSON.stringify({ runId: 'ter_test', taskFingerprint: 'fp', nonce: 'nonce' }));
  writeFileSync(join(etc, 'opencode.json'), JSON.stringify({
    provider: { terrarium: { options: { baseURL: 'https://terrarium.coey.dev/_terrarium_model/v1' }, models: { 'workers-ai': {} } } },
  }));

  const source = runnerSource
    .replace('TASK=/workspace/terrarium-task.txt', `TASK=${join(workspace, 'task')}`)
    .replace('CONTRACT=/workspace/terrarium-contract.json', `CONTRACT=${join(workspace, 'contract')}`)
    .replace('PROVIDER_CONFIG="${OPENCODE_CONFIG:-/etc/terrarium/opencode.json}"', `PROVIDER_CONFIG="\${OPENCODE_CONFIG:-${join(etc, 'opencode.json')}}"`)
    .replace('for candidate in /usr/local/bin/opencode /usr/local/bin/opencode-agent /usr/bin/opencode; do', `for candidate in ${join(dir, 'missing-opencode')}; do`);
  const runner = join(dir, 'runner');
  writeFileSync(runner, source, { mode: 0o755 });
  return { dir, runner };
}

function run(env = {}) {
  const f = fixture();
  try {
    return spawnSync('/bin/sh', [f.runner], {
      env: { PATH: process.env.PATH, TERRARIUM_MODEL: 'terrarium/workers-ai', ...env },
      encoding: 'utf8', timeout: 15_000,
    });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}

function assertCaFailure(result, pattern = /NODE_EXTRA_CA_CERTS/) {
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 11, output);
  assert.match(output, pattern);
  assert.match(output, /TASK_ENDED/);
  assert.doesNotMatch(output, /^TERRARIUM_RESULT=/m);
  assert.doesNotMatch(output, /no OpenCode agent binary/);
}

test('runner fails before OpenCode when configured CA is missing or relative', () => {
  assertCaFailure(run({ NODE_EXTRA_CA_CERTS: '/definitely/missing/terrarium-ca.crt' }));
  assertCaFailure(run({ NODE_EXTRA_CA_CERTS: 'relative-ca.crt' }), /absolute path/);
});

test('runner rejects non-file and unreadable CA values', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'terrarium-ca-values-'));
  try {
    assertCaFailure(run({ NODE_EXTRA_CA_CERTS: dir }));
    if (process.getuid?.() === 0) return t.skip('root can read mode-000 files');
    const file = join(dir, 'unreadable.crt');
    writeFileSync(file, 'certificate');
    chmodSync(file, 0o000);
    try { assertCaFailure(run({ NODE_EXTRA_CA_CERTS: file })); }
    finally { chmodSync(file, 0o600); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runner accepts readable absolute CA and permits unset local probes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'terrarium-readable-ca-'));
  try {
    const file = join(dir, 'ca.crt');
    writeFileSync(file, 'certificate');
    for (const env of [{ NODE_EXTRA_CA_CERTS: file }, {}, { NODE_EXTRA_CA_CERTS: '' }]) {
      const result = run(env);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 3, output);
      assert.match(output, /no OpenCode agent binary present/);
      assert.doesNotMatch(output, /NODE_EXTRA_CA_CERTS/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
