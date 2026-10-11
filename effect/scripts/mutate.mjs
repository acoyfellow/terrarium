#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EQUIVALENT = new Map([
  ["src/owner-store.ts|insert or ignore", "finish() only records a terminal when record.terminal is null, and a Durable Object runs the update and the insert in one synchronous turn, so a second insert for the same event cannot happen; or-ignore is defence in depth"],
]);

const MUTANTS = [
  ["src/receipt.ts", "!==", "==="],
  ["src/receipt.ts", "> 1", "> 2"],
  ["src/receipt.ts", "\"verified\"", "\"missing\""],
  ["src/loop-decide.ts", ">=", ">"],
  ["src/loop-decide.ts", "includes(", "startsWith("],
  ["src/loop-decide.ts", "!attempt.verified", "attempt.verified"],
  ["src/identity.ts", "payload.exp <= nowSeconds", "payload.exp < 0"],
  ["src/identity.ts", "!audiences.includes(config.aud)", "false"],
  ["src/identity.ts", "payload.iss !== ", "false && payload.iss !== "],
  ["src/identity.ts", "difference === 0", "true"],
  ["src/identity.ts", "if (!payload.email)", "if (false)"],
  ["src/owner-store.ts", "insert or ignore", "insert"],
  ["src/owner-store.ts", ">=", ">"],
  ["src/runs.ts", "terminal !== null", "terminal === null"],
  ["src/loops-api.ts", "indexKey(ownerId)", "indexKey(\"shared\")"],
];

const runTests = () => {
  try {
    execFileSync("node", ["--test", "--experimental-strip-types", ...listTests()], { cwd: root, stdio: "ignore", timeout: 300_000 });
    return true;
  } catch {
    return false;
  }
};

const listTests = () => execFileSync("sh", ["-c", "ls test/*.test.ts"], { cwd: root, encoding: "utf8" }).trim().split("\n");

if (!runTests()) {
  console.error("baseline tests fail; fix them before mutating");
  process.exit(2);
}

const results = [];

for (const [file, from, to] of MUTANTS) {
  const path = join(root, file);
  const original = readFileSync(path, "utf8");

  if (!original.includes(from)) {
    results.push({ file, from, to, status: "not-applicable" });
    continue;
  }

  const equivalent = EQUIVALENT.get(`${file}|${from}`);

  if (equivalent) {
    results.push({ file, from, to, status: "equivalent", reason: equivalent });
    continue;
  }

  writeFileSync(path, original.replace(from, to));

  const survived = runTests();

  writeFileSync(path, original);
  results.push({ file, from, to, status: survived ? "SURVIVED" : "killed" });
}

const applicable = results.filter((r) => r.status === "killed" || r.status === "SURVIVED");
const killed = applicable.filter((r) => r.status === "killed").length;
const score = applicable.length ? killed / applicable.length : 0;

for (const r of results) console.log(`${r.status.padEnd(15)} ${r.file}  ${r.from}  ->  ${r.to}`);
console.log(`\ncaught ${killed}/${applicable.length} = ${(score * 100).toFixed(0)}%`);
writeFileSync(join(root, "receipts", "mutation.json"), `${JSON.stringify({ killed, applicable: applicable.length, score, results }, null, 2)}\n`);
process.exit(score >= 0.8 ? 0 : 1);
