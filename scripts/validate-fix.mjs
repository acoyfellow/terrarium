#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateFixPatch } from '../src/fix-policy.js';

const [patchPath, baseRevision, expectedBaseRevision] = process.argv.slice(2);
if (!patchPath || !baseRevision || !expectedBaseRevision) {
  console.error('usage: node scripts/validate-fix.mjs <patch> <base-revision> <expected-base-revision>');
  process.exit(2);
}
try {
  const result = validateFixPatch({ patch: await readFile(patchPath, 'utf8'), baseRevision, expectedBaseRevision });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`fix rejected: ${error.message}`);
  process.exit(1);
}
