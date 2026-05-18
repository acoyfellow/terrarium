import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePatch, childPrompt, defaultMreLogPath, finalizeWorkspace, getRunStatus, isPidAlive, prepareWorkspace, readRun, reconcileRun, spawnTerrariumBackground, splitCommand } from "../src/core.js";

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


test("rejects an unrecorded log path", async () => {
  const logPath = await defaultMreLogPath(`ter_test_unrecorded_${Date.now()}`);
  try {
    writeFileSync(logPath, "not a terrarium log");
    await assert.rejects(() => readRun({ logPath, kind: "mre" }), /not a recorded Terrarium log/);
  } finally {
    rmSync(logPath, { force: true });
  }
});

test("reads a recorded MRE side log", async () => {
  const result = await spawnTerrariumBackground({ task: "noop", dryRun: true, agent: "node -e \"process.exit(0)\"" });
  writeFileSync(result.mreLogPath, "mre side log");
  const read = await readRun({ logPath: result.mreLogPath, kind: "mre" });
  assert.equal(read.kind, "mre");
  assert.equal(read.logPath, result.mreLogPath);
  assert.equal(read.text, "mre side log");
});

test("rejects pre-existing custom MRE side logs", async () => {
  const logPath = await defaultMreLogPath(`ter_test_existing_${Date.now()}`);
  try {
    writeFileSync(logPath, "private data");
    await assert.rejects(() => spawnTerrariumBackground({ task: "noop", dryRun: true, mreLogPath: logPath }), /EEXIST/);
  } finally {
    rmSync(logPath, { force: true });
  }
});

test("background runs finish after the launcher exits", async () => {
  const coreUrl = new URL("../src/core.js", import.meta.url).href;
  const agent = `${process.execPath} -e "setTimeout(() => console.log('supervised child complete'), 80)"`;
  const launcher = `import { spawnTerrariumBackground } from ${JSON.stringify(coreUrl)};\nconst result = await spawnTerrariumBackground(${JSON.stringify({ task: "finish independently", agent })});\nconsole.log(JSON.stringify({ runId: result.runId }));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", launcher], { encoding: "utf8" });
  const { runId } = JSON.parse(output.trim());
  let status;
  for (let i = 0; i < 100; i++) {
    status = await getRunStatus({ runId, staleMs: 5000 });
    if (status.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.status, "done");
  assert.equal(status.exitCode, 0);
  assert.match(status.stdoutTail, /supervised child complete/);
  const log = await readRun({ runId });
  assert.match(log.text, /supervised child complete/);
});

test("reconcileRun marks stale running metadata orphaned when no pid is alive", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "terra-log-"));
  const logPath = join(logDir, "run.log");
  writeFileSync(logPath, "old log");
  const meta = { runId: "ter_test_orphan", status: "running", pid: 99999999, logPath };
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reconciled = await reconcileRun(meta, { staleMs: 0 });
  try {
    assert.equal(isPidAlive(99999999), false);
    assert.equal(reconciled.status, "orphaned");
    assert.equal(reconciled.ok, false);
    assert.match(reconciled.note, /No live Terrarium child process/);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
