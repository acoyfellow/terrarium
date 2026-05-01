// End-to-end test: full-cycle resume across simulated session loss.
//
// Exercises: storage layout, append-only durability, partial-write tolerance,
// the `last` pointer, the handoff renderer, and the actual user promise:
// the next agent gets the context without remembering the run id.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "..", "bin", "wake.js");

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-test-"));
  return dir;
}

// run wake in a clean-ish env (only WAKE_HOME passed through, no WAKE_RUN_ID)
function wake(home, args, { extraEnv = {} } = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME, // harmless; we don't read ~/.wake when WAKE_HOME is set
    WAKE_HOME: home,
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env,
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("full lifecycle + simulated session loss + crash-safe journal", () => {
  const HOME = freshHome();

  // 1. start
  const started = wake(HOME, ["start", "--objective", "refactor parser"]);
  assert.equal(started.code, 0, started.stderr);
  const runId = started.stdout.trim();
  assert.match(runId, /^wake_\d{8}_\d{6}_[0-9a-f]{6}$/);
  assert.ok(fs.existsSync(path.join(HOME, "active")));
  assert.equal(fs.readFileSync(path.join(HOME, "active"), "utf8").trim(), runId);
  assert.ok(fs.existsSync(path.join(HOME, "runs", runId, "run.json")));

  // 2. notes covering every kind
  const notes = [
    ["note", "--kind", "decision", "--text", "use recursive descent"],
    ["note", "--kind", "command", "--cmd", "pnpm test", "--exit", "1", "--output-tail", "TypeError in Lexer:42"],
    ["note", "--kind", "failure", "--text", "lexer regression on numerics"],
    ["note", "--kind", "attempt", "--text", "first pass at expression parser", "--ok"],
    ["note", "--kind", "file", "--file", "src/parser/lexer.ts"],
    ["note", "--kind", "file", "--file", "src/parser/lexer.ts"], // duplicate -> dedupes in summary
    ["note", "--kind", "next", "--text", "write infix-binding-power tests"],
  ];
  for (const args of notes) {
    const r = wake(HOME, args);
    assert.equal(r.code, 0, `note failed: ${args.join(" ")} => ${r.stderr}`);
  }

  // 3. handoff
  const ho = wake(HOME, ["handoff", "--summary", "parser half-done"]);
  assert.equal(ho.code, 0, ho.stderr);
  assert.ok(ho.stdout.includes("HANDOFF.md"));
  assert.ok(ho.stdout.includes("write infix-binding-power tests"));

  // active gone, last set
  assert.equal(fs.existsSync(path.join(HOME, "active")), false);
  assert.equal(fs.readFileSync(path.join(HOME, "last"), "utf8").trim(), runId);
  const handoffPath = path.join(HOME, "runs", runId, "HANDOFF.md");
  assert.ok(fs.existsSync(handoffPath));

  // 4. simulate corruption: append a partial line to journal.ndjson
  const journalPath = path.join(HOME, "runs", runId, "journal.ndjson");
  fs.appendFileSync(journalPath, '{"ts":"2026-05-01T16:99:99Z","kind":"deci'); // truncated mid-write

  // 5. simulated session loss: brand-new wake invocation, no flags, no env
  //    other than WAKE_HOME. Must auto-resolve the run via `last` pointer.
  const resumed = wake(HOME, ["resume"]);
  assert.equal(resumed.code, 0, resumed.stderr);

  // The fresh agent gets all the things the user wanted preserved.
  const out = resumed.stdout;
  assert.match(out, /Objective:\*\*\s+refactor parser/, "objective preserved");
  assert.match(out, /use recursive descent/, "decision preserved");
  assert.match(out, /lexer regression on numerics/, "failure preserved");
  assert.match(out, /pnpm test/, "command preserved");
  assert.match(out, /src\/parser\/lexer\.ts/, "changed file preserved");
  assert.match(out, /write infix-binding-power tests/, "next step preserved");
  assert.match(out, /parser half-done/, "summary preserved");

  // dedupe: "src/parser/lexer.ts" appears in changed-files exactly once
  const fileSection = out.split("## Changed files")[1] || "";
  const occurrences = (fileSection.match(/src\/parser\/lexer\.ts/g) || []).length;
  assert.equal(occurrences, 1, "duplicate file paths should dedupe to one entry");

  // 6. status --json works and is structured
  const stj = wake(HOME, ["status", "--json"]);
  assert.equal(stj.code, 0, stj.stderr);
  const parsed = JSON.parse(stj.stdout);
  assert.equal(parsed.id, runId);
  assert.equal(parsed.run.status, "handoff");
  assert.equal(parsed.nextStep, "write infix-binding-power tests");
});

test("WAKE_HOME isolation: zero writes outside the temp home", () => {
  const HOME = freshHome();
  const before = fs.existsSync(path.join(os.homedir(), ".wake"))
    ? fs.statSync(path.join(os.homedir(), ".wake")).mtimeMs
    : null;
  const r = wake(HOME, ["start", "--objective", "isolation check"]);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(HOME, "runs")));
  // If a real ~/.wake exists, its mtime must not have changed.
  if (before !== null) {
    const after = fs.statSync(path.join(os.homedir(), ".wake")).mtimeMs;
    assert.equal(before, after, "must not touch real ~/.wake");
  }
});

test("starting a second run while one is open errors out", () => {
  const HOME = freshHome();
  const a = wake(HOME, ["start", "--objective", "first"]);
  assert.equal(a.code, 0);
  const b = wake(HOME, ["start", "--objective", "second"]);
  assert.notEqual(b.code, 0);
  assert.match(b.stderr, /still active/);
});
