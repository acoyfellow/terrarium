import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const RUN_ID = 'ter_20260721_abcdef0123456789';
const TASK_FP = 'fp_0011223344556677';
const NONCE = 'nonce-9f8e7d6c5b4a';

// Build a temp fixture for a given runner script. Both runners are covered:
//  - scripts/terrarium-runner      (opencode agent, Dockerfile)
//  - scripts/terrarium-runner-pi   (pi agent, Dockerfile.pi -> the PROD image)
// The fake agent binary prints a FIXED stdout (the receipt line under test) and
// exits 0; a fake `timeout` execs the command directly.
function fixture(scriptName, agentStdout) {
  const runnerSource = readFileSync(join(root, 'scripts', scriptName), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'terrarium-runner-receipt-'));
  const workspace = join(dir, 'workspace');
  const etc = join(dir, 'etc');
  const bin = join(dir, 'bin');
  mkdirSync(workspace); mkdirSync(etc); mkdirSync(bin);
  writeFileSync(join(workspace, 'task'), 'do the bounded task');
  writeFileSync(join(workspace, 'contract'), JSON.stringify({ runId: RUN_ID, taskFingerprint: TASK_FP, nonce: NONCE }));
  // Fake timeout: exec the command directly (strip "--signal=.. --kill-after=.. <dur>s").
  writeFileSync(join(bin, 'timeout'), `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --*) shift;; *[0-9]s) shift;; *) break;; esac; done\nexec "$@"\n`, { mode: 0o755 });

  let source, env, runner = join(dir, 'runner');
  if (scriptName === 'terrarium-runner') {
    writeFileSync(join(etc, 'opencode.json'), JSON.stringify({
      provider: { terrarium: { options: { baseURL: 'https://terrarium.coey.dev/_terrarium_model/v1' }, models: { 'workers-ai': {} } } },
    }));
    const fakeOpencode = join(bin, 'opencode');
    writeFileSync(fakeOpencode, `#!/bin/sh\ncat <<'EOF'\nthinking about the task...\ndid the work\n${agentStdout}\nEOF\nexit 0\n`, { mode: 0o755 });
    source = runnerSource
      .replace('TASK=/workspace/terrarium-task.txt', `TASK=${join(workspace, 'task')}`)
      .replace('CONTRACT=/workspace/terrarium-contract.json', `CONTRACT=${join(workspace, 'contract')}`)
      .replace('PROVIDER_CONFIG="${OPENCODE_CONFIG:-/etc/terrarium/opencode.json}"', `PROVIDER_CONFIG="\${OPENCODE_CONFIG:-${join(etc, 'opencode.json')}}"`)
      .replace('for candidate in /usr/local/bin/opencode /usr/local/bin/opencode-agent /usr/bin/opencode; do', `for candidate in ${fakeOpencode}; do`);
    env = { PATH: `${bin}:${process.env.PATH}`, TERRARIUM_MODEL: 'terrarium/workers-ai' };
  } else {
    // pi runner: env-var overrides for task/contract/provider; fake `pi` binary.
    writeFileSync(join(etc, 'terrarium-provider.mjs'), 'export default {};\n');
    const fakePi = join(bin, 'pi');
    writeFileSync(fakePi, `#!/bin/sh\ncat <<'EOF'\nworking...\n${agentStdout}\nEOF\nexit 0\n`, { mode: 0o755 });
    source = runnerSource
      .replace('for candidate in /usr/local/bin/pi /usr/bin/pi "$(command -v pi 2>/dev/null || true)"; do', `for candidate in ${fakePi}; do`);
    env = {
      PATH: `${bin}:${process.env.PATH}`,
      TERRARIUM_MODEL: 'terrarium/workers-ai',
      TERRARIUM_TASK_FILE: join(workspace, 'task'),
      TERRARIUM_CONTRACT_FILE: join(workspace, 'contract'),
      TERRARIUM_PI_PROVIDER: join(etc, 'terrarium-provider.mjs'),
      TERRARIUM_CELL_HOME: join(dir, 'cell-home'),
    };
  }
  writeFileSync(runner, source, { mode: 0o755 });
  return { dir, runner, bin, env };
}

let CURRENT_SCRIPT = 'terrarium-runner';
function run(agentStdout, extraEnv = {}) {
  const f = fixture(CURRENT_SCRIPT, agentStdout);
  try {
    const r = spawnSync('/bin/sh', [f.runner], {
      env: { ...f.env, ...extraEnv },
      encoding: 'utf8', timeout: 15_000,
    });
    return { ...r, output: `${r.stdout}\n${r.stderr}` };
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}

function receiptLine(output) {
  return output.split('\n').find((l) => l.startsWith('TERRARIUM_RESULT='));
}

for (const script of ['terrarium-runner', 'terrarium-runner-pi']) {
  test(`[${script}] receipt contract`, async (t) => {
    CURRENT_SCRIPT = script;

    await t.test('minimal receipt {nonce,summary} is accepted; runner assembles canonical receipt', () => {
      const r = run(`TERRARIUM_RESULT={"nonce":"${NONCE}","summary":"wrote the spec"}`);
      assert.equal(r.status, 0, r.output);
      const line = receiptLine(r.output);
      assert.ok(line, `expected a TERRARIUM_RESULT line in:\n${r.output}`);
      const obj = JSON.parse(line.slice('TERRARIUM_RESULT='.length));
      // Runner fills in the canonical framing even though the agent omitted it.
      assert.equal(obj.runId, RUN_ID);
      assert.equal(obj.taskFingerprint, TASK_FP);
      assert.equal(obj.nonce, NONCE);
      assert.equal(obj.summary, 'wrote the spec');
    });

    await t.test('full receipt echoing correct framing is still accepted (backward compatible)', () => {
      const r = run(`TERRARIUM_RESULT={"runId":"${RUN_ID}","taskFingerprint":"${TASK_FP}","nonce":"${NONCE}","summary":"full echo"}`);
      assert.equal(r.status, 0, r.output);
      const obj = JSON.parse(receiptLine(r.output).slice('TERRARIUM_RESULT='.length));
      assert.equal(obj.runId, RUN_ID);
      assert.equal(obj.summary, 'full echo');
    });

    await t.test('the OLD failure mode (small model omits the long id) NOW SUCCEEDS via the minimal path', () => {
      const r = run(`TERRARIUM_RESULT={"nonce":"${NONCE}","summary":"work done, no id echoed"}`);
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, /work done, no id echoed/);
    });

    await t.test('wrong nonce is still rejected (proof-of-execution preserved)', () => {
      const r = run(`TERRARIUM_RESULT={"nonce":"not-the-nonce","summary":"forged"}`);
      assert.equal(r.status, 6, r.output);
      assert.match(r.output, /receipt did not match contract \(mismatch:nonce\)/);
      assert.doesNotMatch(r.output, /^TERRARIUM_RESULT=/m);
    });

    await t.test('an echoed WRONG runId (with correct nonce) is still rejected as mismatch:runId', () => {
      const r = run(`TERRARIUM_RESULT={"runId":"ter_WRONG","nonce":"${NONCE}","summary":"x"}`);
      assert.equal(r.status, 6, r.output);
      assert.match(r.output, /mismatch:runId/);
    });

    await t.test('missing summary is malformed', () => {
      const r = run(`TERRARIUM_RESULT={"nonce":"${NONCE}"}`);
      assert.equal(r.status, 7, r.output);
      assert.match(r.output, /malformed:summary-empty/);
    });

    await t.test('extra keys are still rejected', () => {
      const r = run(`TERRARIUM_RESULT={"nonce":"${NONCE}","summary":"x","evil":1}`);
      assert.equal(r.status, 7, r.output);
      assert.match(r.output, /malformed:extra-keys:evil/);
    });

    await t.test('no receipt line at all is exit 4', () => {
      const r = run(`(no marker here)`);
      assert.equal(r.status, 4, r.output);
      assert.match(r.output, /emitted no TERRARIUM_RESULT= line/);
    });
  });
}
