import { writeFile } from 'node:fs/promises';
import { runSecureTask } from '../src/secure.js';

const tasks = [
  'run the policy tests',
  'check source syntax and imports',
  'validate package metadata',
  'validate documentation',
  'validate public schema and redaction',
];
const results = [];
for (const task of tasks) {
  const start = performance.now();
  const receipt = await runSecureTask({ task });
  results.push({ task, success: receipt.verdict === 'completed' && receipt.teardownVerified, durationMs: Math.round(performance.now() - start), profile: receipt.profile.id, sourceRevision: receipt.sourceRevision, taskDigest: receipt.taskDigest });
}
const report = { generatedAt: new Date().toISOString(), tasks: results.length, passed: results.filter((r) => r.success).length, results };
await writeFile('docs/SECURE_V1_BENCHMARK.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
