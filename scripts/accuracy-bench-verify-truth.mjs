#!/usr/bin/env node
// Ground-truth self-check for the accuracy bench. A harness is only as
// trustworthy as its labels; C1 exhaust proved my own fixture had a 2/12
// ground-truth error rate. This independently recomputes every
// machine-computable expected answer and flags mismatches. Non-computable
// answers (factual/city names) are listed for manual review, not auto-scored.
//
// Usage: node scripts/accuracy-bench-verify-truth.mjs [fixture.json ...]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Independent recomputation of the computable tasks by id. If a task id is here,
// its expected value MUST equal the computed value or the fixture is buggy.
const COMPUTED = {
  'mul-1': () => 17 * 23,
  'mul-2': () => 144 / 12,
  'mul-3': () => 2 ** 10,
  'add-1': () => 4096 + 4096,
  'fact-2': () => 6,
  'string-1': () => [...'strawberry'].filter((c) => c === 'r').length,
  'seq-1': () => 32,
  'h-mul-1': () => 347 * 289,
  'h-mul-2': () => 4567 * 8901,
  'h-chain-1': () => 23 * 17 + 89 * 4 - 156,
  'h-chain-2': () => 60 * (60 / 45) * 2,
  'h-str-1': () => [...'possessions'].filter((c) => c === 's').length,
  'h-str-2': () => 'the quick brown fox jumps'.split(' ').length,
  'h-str-3': () => [...'algorithm'].reverse().join(''),
  'h-logic-1': () => 5,
  'h-logic-2': () => 5,
  'h-date-1': () => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][(3 + 100) % 7],
  'h-count-1': () => { let n = 0; for (let i = 1; i <= 100; i++) if (i % 3 === 0 && i % 4 === 0) n++; return n; },
  'h-mul-3': () => 789 * 456,
  'h-mul-4': () => 1234 * 5678,
  'h-chain-3': () => (144 / 12) * (15 - 7) + 100,
  'h-str-4': () => [...'effervescence'].filter((c) => c === 'e').length,
  'h-str-5': () => [...'parallel'].reverse().join(''),
  'h-count-2': () => { const isP = (x) => { if (x < 2) return false; for (let d = 2; d * d <= x; d++) if (x % d === 0) return false; return true; }; let n = 0; for (let i = 1; i <= 50; i++) if (isP(i)) n++; return n; },
  'h-date-2': () => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][((1 - 30) % 7 + 7) % 7],
  'h-mul-5': () => 63 * 87,
  'h-mul-6': () => 2048 * 512,
  'h-chain-4': () => (500 - 37 * 13) / 2,
  'h-mod-1': () => 1000 % 7,
  'h-str-6': () => [...'encyclopedia'].filter((c) => 'aeiou'.includes(c)).length,
  'h-str-7': () => 'hello world'.length,
  'h-count-3': () => Array.from({ length: 20 }, (_, i) => i + 1).reduce((a, b) => a + b, 0),
  'h-logic-4': () => Math.abs((3 * 30 + (15 / 60) * 30) - ((15 / 60) * 360)),
  'h-seq-2': () => 21,
  "h-mul-7": () => 923 * 641,
  "h-mul-8": () => 7777 * 3,
  "h-chain-5": () => 15 * 15 - 15 + 15 / 15,
  "h-mod-2": () => 2025 % 12,
  "h-count-4": () => { let n=0; for(let i=1;i<=100;i++){const r=Math.sqrt(i); if(Number.isInteger(r))n++;} return n; },
  "h-str-8": () => [..."banana"].filter((c)=>c==="a").length,
  "h-str-9": () => [..."receipt"].reverse().join(""),
  "h-logic-5": () => 3,
  "h-date-3": () => 31 + 28 + 31,
};

const files = process.argv.slice(2);
if (files.length === 0) files.push('fixtures/accuracy-bench/tasks.json', 'fixtures/accuracy-bench/tasks-hard.json');

let bad = 0, checked = 0, manual = 0;
for (const f of files) {
  const bench = JSON.parse(readFileSync(join(root, f), 'utf8'));
  for (const t of bench.tasks) {
    if (COMPUTED[t.id]) {
      checked++;
      const computed = String(COMPUTED[t.id]());
      if (computed !== String(t.expected)) {
        bad++;
        console.error(`MISMATCH ${f} ${t.id}: expected="${t.expected}" computed="${computed}"`);
      }
    } else {
      manual++;
      console.log(`manual-review ${t.id}: "${t.expected}" (${t.prompt.slice(0, 50)}...)`);
    }
  }
}
console.log(`\nground-truth check: ${checked} computed, ${bad} mismatches, ${manual} manual-review`);
process.exit(bad > 0 ? 1 : 0);
