#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

const step = (name, run) => {
  try {
    const detail = run();
    results.push({ name, pass: true, detail });
  } catch (error) {
    results.push({ name, pass: false, detail: String(error?.message ?? error).split("\n").slice(0, 3).join(" ") });
  }
};

const sh = (command) => execFileSync("sh", ["-c", command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 1_800_000 });

const receipt = (name) => JSON.parse(readFileSync(join(root, "receipts", name), "utf8"));

step("1 test audit: every old test labelled keep or drop, user approved", () => {
  const audit = readFileSync(join(root, "TEST-AUDIT.md"), "utf8");
  const rows = audit.split("\n").filter((line) => /^\|\s*[a-z0-9_.-]+\.test\.js\s*\|\s*(KEEP|DROP)\s*\|/i.test(line)).length;

  if (rows < 102) throw new Error(`only ${rows} of 102 test files labelled`);

  if (!/^Approved by the user:/m.test(audit)) throw new Error("drop list not yet approved by the user");

  return `${rows} files labelled, approved`;
});

step("2a typecheck", () => {
  sh("npx tsc --noEmit -p .");
  return "clean";
});

step("2b anti-slop lint", () => {
  sh("npx oxlint -c oxlint.config.ts src test");
  return "clean";
});

step("2c all tests pass", () => {
  const out = sh("node --test --experimental-strip-types test/*.test.ts 2>&1 | grep -E '^ℹ (pass|fail)'");
  const fail = Number(/ℹ fail (\d+)/.exec(out)?.[1] ?? 1);

  if (fail !== 0) throw new Error(out.trim());

  return out.trim().replaceAll("\n", ", ");
});

step("2d no async/await or try/catch in business logic", () => {
  const boundary = new Set(["src/worker.ts", "src/owner-do.ts", "src/sandbox.ts", "src/run-workflow.ts", "src/loop-workflow.ts", "src/worker-configuration.d.ts"]);
  const offenders = sh("grep -lnE '\\basync\\b|\\bawait\\b|\\btry\\s*\\{' src/*.ts || true").trim().split("\n").filter((f) => f && !boundary.has(f));

  if (offenders.length) throw new Error(`async/try in ${offenders.join(", ")}`);

  return "only entry boundaries use async";
});

step("3 planted-bug check catches at least 80%", () => {
  sh("node scripts/mutate.mjs");
  const mutation = receipt("mutation.json");

  return `${mutation.killed}/${mutation.applicable}`;
});

step("4 prod checks on AX", () => {
  if (!existsSync(join(root, "receipts", "prod-checks.json"))) throw new Error("run scripts/prod-checks.mjs first");

  const prod = receipt("prod-checks.json");

  if (!prod.ok) throw new Error(prod.checks.filter((c) => !c.pass).map((c) => c.name).join(", "));

  return `${prod.checks.length}/${prod.checks.length} at ${prod.at}`;
});

const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

const freshPassing = (name, stampKey) => {
  if (!existsSync(join(root, "receipts", name))) throw new Error(`run the check that writes receipts/${name} first`);

  const data = receipt(name);
  const ageMs = Date.now() - Date.parse(data[stampKey]);

  if (!data.ok) throw new Error(`${name} is not ok`);

  if (!(ageMs < FRESH_MS)) throw new Error(`${name} is older than 7 days`);

  return data;
};

step("4b sealed box: outside sites blocked, model reachable, no secrets", () => {
  const egress = freshPassing("egress.json", "at");

  return `${egress.checks.length}/${egress.checks.length} at ${egress.at}`;
});

step("4c proof runs: honest work passes, a false claim fails", () => {
  const proofRun = freshPassing("proof-run.json", "checkedAt");

  return proofRun.results.map((result) => `${result.ok ? "ok" : "FAIL"} ${result.name}`).join("; ");
});

step("5 benchmark committed", () => {
  const bench = receipt("bench.json");

  return `${bench.current.sourceLines} lines -> ${bench.effect.sourceLines} lines`;
});

for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);

const ok = results.every((r) => r.pass);
console.log(ok ? "\nGATE PASSES" : "\nGATE FAILS");
process.exit(ok ? 0 : 1);
