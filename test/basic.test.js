import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childPrompt, prepareWorkspace, splitCommand } from "../src/core.js";

test("builds a constrained child prompt", () => {
  assert.match(childPrompt("ship it", { depth: 1, maxDepth: 3 }), /Do not fan out/);
  assert.deepEqual(splitCommand('node -e "console.log(1)"'), ["node", "-e", "console.log(1)"]);
});


test("copy isolation creates a writable workspace without mutating source", async () => {
  const source = mkdtempSync(join(tmpdir(), "terra-source-"));
  try {
    writeFileSync(join(source, "file.txt"), "source");
    writeFileSync(join(source, "node_modules"), "excluded marker");
  } catch {
    // If node_modules as file fails on an odd platform, ignore; the directory case is covered by basename filtering.
  }

  const run = { runId: "ter_test_copy", originalCwd: source, cwd: source, isolation: "copy", keepWorkspace: true };
  const workspace = await prepareWorkspace(run);
  try {
    assert.equal(workspace.type, "copy");
    assert.notEqual(run.cwd, source);
    assert.equal(readFileSync(join(run.cwd, "file.txt"), "utf8"), "source");
    writeFileSync(join(run.cwd, "file.txt"), "child");
    assert.equal(readFileSync(join(source, "file.txt"), "utf8"), "source");
    assert.equal(existsSync(join(run.cwd, ".terrarium-workspace")), true);
  } finally {
    rmSync(workspace.path, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  }
});
