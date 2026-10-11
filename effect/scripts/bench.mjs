#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const effectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(effectRoot, "..");

const lines = (cwd, pattern) => {
  const out = execFileSync("sh", ["-c", `ls ${pattern} 2>/dev/null | xargs cat 2>/dev/null | grep -cv '^[[:space:]]*$' || true`], { cwd, encoding: "utf8" });
  return Number(out.trim()) || 0;
};

const files = (cwd, pattern) => {
  const out = execFileSync("sh", ["-c", `ls ${pattern} 2>/dev/null | wc -l`], { cwd, encoding: "utf8" });
  return Number(out.trim()) || 0;
};

const timeTests = (cwd, command) => {
  const started = Date.now();
  const out = execFileSync("sh", ["-c", `${command} 2>&1 | grep -E '^ℹ (pass|fail)' || true`], { cwd, encoding: "utf8", timeout: 1_800_000 });
  const pass = Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? 0);
  const fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 0);
  return { pass, fail, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
};

const prod = JSON.parse(readFileSync(join(effectRoot, "receipts", "prod-checks.json"), "utf8"));
const mutation = JSON.parse(readFileSync(join(effectRoot, "receipts", "mutation.json"), "utf8"));

const current = {
  sourceFiles: files(repo, "src/*.js src/cloud/*.js src/pulse/*.js"),
  sourceLines: lines(repo, "src/*.js src/cloud/*.js src/pulse/*.js"),
  testFiles: files(repo, "test/*.test.js"),
  tests: timeTests(repo, "node scripts/test-isolated.mjs"),
};

const effect = {
  sourceFiles: files(effectRoot, "src/*.ts") - 1,
  sourceLines: lines(effectRoot, "src/[!w]*.ts src/worker.ts"),
  testFiles: files(effectRoot, "test/*.test.ts"),
  tests: timeTests(effectRoot, "node --test --experimental-strip-types test/*.test.ts"),
  mutationScore: mutation.score,
  prodChecks: { ok: prod.ok, passed: prod.checks.filter((c) => c.pass).length, total: prod.checks.length },
};

const result = { at: new Date().toISOString(), current, effect, linesRatio: Number((current.sourceLines / effect.sourceLines).toFixed(1)) };
writeFileSync(join(effectRoot, "receipts", "bench.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
