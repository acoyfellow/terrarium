#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const receiptDir = join(root, 'receipts', 'product-loop');
const publicDir = join(root, 'app', 'public', 'campaign', 'receipts');

function run(command, args, options = {}) {
  const started = new Date().toISOString();
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: options.timeout ?? 120_000 });
  return {
    command: [command, ...args].join(' '),
    startedAt: started,
    finishedAt: new Date().toISOString(),
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').slice(-4000),
    stderr: (result.stderr || '').slice(-4000),
  };
}

function assertPublicSummary(summary) {
  if (!summary || typeof summary !== 'object') throw new Error('public summary must be an object');
  if (!summary.iterationId) throw new Error('public summary missing iterationId');
  if (summary.evidenceClaim === true && !summary.evidenceRef) throw new Error('evidenceClaim true requires evidenceRef');
  for (const key of ['privateRunMetadata', 'task', 'prompt', 'cwd', 'logPath', 'output']) {
    if (JSON.stringify(summary).includes(`"${key}"`)) throw new Error(`public summary leaks ${key}`);
  }
}

export async function createIterationReceipt({ intent = 'product hardening loop bootstrap', selectedWork = null, publicSummary = null, dryRun = false } = {}) {
  if (!dryRun) {
    await mkdir(receiptDir, { recursive: true });
    await mkdir(publicDir, { recursive: true });
  }
  const files = await readFile(new URL('../package.json', import.meta.url), 'utf8').then(() => []).catch(() => []);
  const iterationId = `ph-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const commands = [
    run('git', ['status', '--short'], { timeout: 30_000 }),
    run('npm', ['run', 'demo:build']),
    run('node', ['--test', 'test/product-loop.test.js']),
  ];
  const health = {
    repoCleanAtStart: commands[0].ok && commands[0].stdout.trim() === '',
    buildOk: commands[1].ok,
    validationOk: commands[2].ok,
  };
  const canPublishStory = health.repoCleanAtStart && health.buildOk && health.validationOk;
  const receipt = {
    schema: 'terrarium.product-loop.receipt.v0.1',
    iterationId,
    intent,
    phases: ['OBSERVE', 'SELECT', 'EXECUTE', 'VERIFY', 'RECORD', 'PUBLIC_SUMMARIZE', 'OPTIONAL_DEPLOY'],
    selectedWork: selectedWork ?? {
      kind: 'loop-infrastructure',
      reason: 'Storytelling must become a byproduct of verified product-hardening work.',
    },
    health,
    commands,
    publicSummary: publicSummary ?? {
      iterationId,
      contentKind: 'product-summary',
      evidenceClaim: false,
      title: 'Product hardening loop bootstrap',
      summary: 'This iteration records loop health and validation before allowing public storytelling.',
    },
    canPublishStory,
    createdAt: new Date().toISOString(),
  };
  assertPublicSummary(receipt.publicSummary);
  const privatePath = join(receiptDir, `${iterationId}.json`);
  const publicPath = join(publicDir, `${iterationId}.public.json`);
  if (!dryRun) {
    await writeFile(privatePath, `${JSON.stringify(receipt, null, 2)}\n`);
    await writeFile(publicPath, `${JSON.stringify(receipt.publicSummary, null, 2)}\n`);
  }
  return { receipt, privatePath, publicPath, dryRun };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  const result = await createIterationReceipt({ dryRun });
  console.log(JSON.stringify({ ok: true, dryRun, iterationId: result.receipt.iterationId, canPublishStory: result.receipt.canPublishStory, privatePath: result.privatePath, publicPath: result.publicPath }, null, 2));
}
