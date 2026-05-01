import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePatch, childPrompt, finalizeWorkspace, prepareWorkspace, splitCommand } from "../src/core.js";

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
    try { rmSync(source, { recursive: true, force: true }); } catch {}
  }
});


function initRepo(dir) {
  execSync("git init -q -b main", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir, XDG_CONFIG_HOME: dir } });
  execSync("git config user.email t@t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  execSync("git config core.hooksPath /dev/null", { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "tracked\n");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
}

test("worktree isolation writes a marker and cleans up branch + registration", async () => {
  const source = mkdtempSync(join(tmpdir(), "terra-wt-"));
  initRepo(source);
  const runId = `ter_test_wt_${Date.now()}`;
  const run = { runId, originalCwd: source, cwd: source, isolation: "worktree", keepWorkspace: false };
  const workspace = await prepareWorkspace(run);
  try {
    assert.equal(workspace.type, "worktree");
    assert.equal(workspace.branch, `terrarium/${runId}`);
    const marker = JSON.parse(readFileSync(join(workspace.path, ".terrarium-workspace"), "utf8"));
    assert.equal(marker.runId, runId);
    assert.equal(marker.isolation, "worktree");

    const wtList = execSync("git worktree list --porcelain", { cwd: source }).toString();
    assert.match(wtList, new RegExp(workspace.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await finalizeWorkspace(workspace, { runId });

    assert.equal(existsSync(workspace.path), false);
    const wtListAfter = execSync("git worktree list --porcelain", { cwd: source }).toString();
    assert.doesNotMatch(wtListAfter, new RegExp(workspace.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const branches = execSync("git branch --list", { cwd: source }).toString();
    assert.doesNotMatch(branches, /terrarium\//);
  } finally {
    try { rmSync(source, { recursive: true, force: true }); } catch {}
  }
});

test("capturePatch includes untracked new files and excludes the workspace marker", async () => {
  const source = mkdtempSync(join(tmpdir(), "terra-patch-"));
  initRepo(source);
  const runId = `ter_test_patch_${Date.now()}`;
  const run = { runId, originalCwd: source, cwd: source, isolation: "worktree", keepWorkspace: true };
  const workspace = await prepareWorkspace(run);
  try {
    writeFileSync(join(workspace.path, "tracked.txt"), "edited\n");
    writeFileSync(join(workspace.path, "fresh.txt"), "brand new\n");
    const diff = await capturePatch(workspace.path);
    assert.equal(diff.code, 0);
    assert.match(diff.stdout, /tracked\.txt/);
    assert.match(diff.stdout, /fresh\.txt/);
    assert.match(diff.stdout, /brand new/);
    assert.doesNotMatch(diff.stdout, /\.terrarium-workspace/);
  } finally {
    await finalizeWorkspace({ ...workspace, cleanup: true }, { runId });
    try { rmSync(source, { recursive: true, force: true }); } catch {}
  }
});
