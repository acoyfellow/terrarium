import { spawnSync } from 'node:child_process';

// Unit tests that require neither Docker-in-Docker, host git metadata, network,
// nor external credentials. These exercise core policy, redaction, and schemas
// inside secure-v1 without weakening the sandbox to run its own outer detectors.
const files = [
  'test/adaptive.test.js',
  'test/controller-auth.test.js',
  'test/fix-policy.test.js',
  'test/healing-cli.test.js',
  'test/lab.test.js',
  'test/public-ledger.test.js',
  'test/replay-gate.test.js',
  'test/trace-events.test.js',
  'test/scenario-registry.test.js',
];
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
