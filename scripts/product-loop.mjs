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

const EVIDENCE_REF_PATTERNS = Object.freeze([
  /^commit:[a-f0-9]{7,40}$/i,
  /^terrarium-run:ter_\d{17}_[a-z0-9]+$/i,
  /^test:(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  /^replay:[A-Za-z0-9][A-Za-z0-9._-]*$/,
]);

const PUBLIC_SUMMARY_KEYS = Object.freeze(['iterationId', 'contentKind', 'evidenceClaim', 'evidenceRef', 'title', 'summary']);

export function assertPublicSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new Error('public summary must be an object');
  const unknownKeys = Object.keys(summary).filter((key) => !PUBLIC_SUMMARY_KEYS.includes(key));
  if (unknownKeys.length) throw new Error(`public summary has unknown fields: ${unknownKeys.join(', ')}`);
  if (typeof summary.iterationId !== 'string' || !/^ph-\d{14}$/.test(summary.iterationId)) throw new Error('public summary has invalid iterationId');
  if (summary.contentKind !== 'product-summary') throw new Error('public summary has invalid contentKind');
  if (typeof summary.evidenceClaim !== 'boolean') throw new Error('public summary evidenceClaim must be boolean');
  for (const key of ['title', 'summary']) {
    if (typeof summary[key] !== 'string' || !summary[key].trim() || summary[key] !== summary[key].trim() || /[\r\n\u2028\u2029]/u.test(summary[key])) {
      throw new Error(`public summary has invalid ${key}`);
    }
  }
  if (summary.evidenceClaim === true) {
    if (typeof summary.evidenceRef !== 'string' || !EVIDENCE_REF_PATTERNS.some((pattern) => pattern.test(summary.evidenceRef))) {
      throw new Error('evidenceClaim true requires a checkable evidenceRef');
    }
  } else if ('evidenceRef' in summary) {
    throw new Error('evidenceClaim false must omit evidenceRef');
  }
  for (const key of ['privateRunMetadata', 'task', 'prompt', 'cwd', 'logPath', 'output']) {
    if (JSON.stringify(summary).includes(`"${key}"`)) throw new Error(`public summary leaks ${key}`);
  }
}

export const OUTER_LOOP_ROLES = Object.freeze(['investigator', 'implementer', 'reviewer']);

export function reconcileOuterLoop(plan = {}) {
  const roles = Array.isArray(plan.roles) ? plan.roles : [];
  const roleNames = roles.map((role) => role?.role);
  const missingRoles = OUTER_LOOP_ROLES.filter((role) => !roleNames.includes(role));
  const duplicateRoles = [...new Set(roleNames.filter((role, index) => roleNames.indexOf(role) !== index))];
  const invalidRoles = roleNames.filter((role) => !OUTER_LOOP_ROLES.includes(role));
  const unboundedRoles = roles
    .filter((role) => !role?.task || typeof role.task !== 'string' || !role.task.trim())
    .map((role) => role?.role ?? null);
  const errors = [];
  if (roles.length !== 3) errors.push(`expected exactly 3 roles, received ${roles.length}`);
  if (missingRoles.length) errors.push(`missing roles: ${missingRoles.join(', ')}`);
  if (duplicateRoles.length) errors.push(`duplicate roles: ${duplicateRoles.join(', ')}`);
  if (invalidRoles.length) errors.push(`invalid roles: ${invalidRoles.join(', ')}`);
  if (unboundedRoles.length) errors.push(`roles missing bounded tasks: ${unboundedRoles.join(', ')}`);
  return {
    schema: 'terrarium.product-loop.plan-check.v0.1',
    ok: errors.length === 0,
    spawnsChildren: false,
    expectedRoles: OUTER_LOOP_ROLES,
    errors,
  };
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
  if (receipt.publicSummary.iterationId !== iterationId) throw new Error('public summary iterationId must match its receipt');
  if (receipt.publicSummary.evidenceClaim === true && !canPublishStory) {
    throw new Error('cannot publish an evidence claim while product-loop health is red');
  }
  const privatePath = join(receiptDir, `${iterationId}.json`);
  const publicPath = join(publicDir, `${iterationId}.public.json`);
  if (!dryRun) {
    await writeFile(privatePath, `${JSON.stringify(receipt, null, 2)}\n`);
    await writeFile(publicPath, `${JSON.stringify(receipt.publicSummary, null, 2)}\n`);
  }
  return { receipt, privatePath, publicPath, dryRun };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === 'check') {
    const planPath = args[1];
    if (!planPath) throw new Error('usage: product-loop.mjs check <plan.json>');
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    const result = reconcileOuterLoop(plan);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else {
    const dryRun = args.includes('--dry-run');
    const result = await createIterationReceipt({ dryRun });
    console.log(JSON.stringify({ ok: true, dryRun, iterationId: result.receipt.iterationId, canPublishStory: result.receipt.canPublishStory, privatePath: result.privatePath, publicPath: result.publicPath }, null, 2));
  }
}
