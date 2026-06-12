import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyModelToAgent, assertRunId, capturePatch, childPrompt, defaultMreLogPath, finalizeWorkspace, getRunStatus, isPidAlive, prepareWorkspace, readRun, reconcileRun, resolveAgent, resolveModel, resolvePromptProfile, runTerrarium, spawnTerrariumBackground, splitCommand, READ_ONLY_AGENT } from "../src/core.js";

test("builds a constrained child prompt", () => {
  assert.match(childPrompt("ship it", { depth: 1, maxDepth: 3 }), /Do not fan out/);
  assert.deepEqual(splitCommand('node -e "console.log(1)"'), ["node", "-e", "console.log(1)"]);
});

test("childPrompt default profile keeps the full structured contract", () => {
  const out = childPrompt("ship it", { depth: 1, maxDepth: 3, runId: "r1", parentRunId: null });
  assert.match(out, /You are a Terrarium child agent\./);
  assert.match(out, /Do not fan out\./);
  assert.match(out, /Summary:\nChanged files:\nVerification:\nFollow-ups:/);
  assert.match(out, /Task:\nship it/);
});

test("childPrompt minimal profile drops the role banner and the depth/run-id ceremony", () => {
  const out = childPrompt("ship it", { profile: "minimal" });
  assert.match(out, /Terrarium child\. Single bounded task\. Do not spawn subagents\./);
  assert.match(out, /Reply with: Summary, Changed files, Verification\./);
  assert.match(out, /Task:\nship it/);
  assert.doesNotMatch(out, /You are a Terrarium child agent/);
  assert.doesNotMatch(out, /Run ID:/);
  assert.doesNotMatch(out, /Current Terrarium depth/);
  const def = childPrompt("ship it", { profile: "default", depth: 1, maxDepth: 3 });
  assert.ok(out.length < def.length, `minimal (${out.length}) should be shorter than default (${def.length})`);
});

test("childPrompt rejects unknown profile names", () => {
  assert.throws(() => childPrompt("x", { profile: "tiny" }), /unknown prompt profile: tiny/);
  assert.throws(() => resolvePromptProfile("nope"), /unknown prompt profile/);
});

test("resolveAgent precedence: explicit > readOnly > env > config > default", () => {
  assert.equal(resolveAgent({}, { env: {}, config: {} }), "opencode run");
  assert.equal(resolveAgent({}, { env: {}, config: { defaultAgent: "pi run" } }), "pi run");
  assert.equal(resolveAgent({}, { env: { TERRARIUM_AGENT: "claude run" }, config: { defaultAgent: "pi run" } }), "claude run");
  assert.equal(resolveAgent({ readOnly: true }, { env: { TERRARIUM_AGENT: "claude run" }, config: { defaultAgent: "pi run" } }), READ_ONLY_AGENT);
  assert.equal(resolveAgent({ agent: "custom run", readOnly: true }, { env: { TERRARIUM_AGENT: "claude run" }, config: { defaultAgent: "pi run" } }), "custom run");
});

test("READ_ONLY_AGENT remains the compatibility fallback", () => {
  assert.equal(READ_ONLY_AGENT, "opencode run --agent explore");
});

test("read-only agent can be configured independently of the ordinary runner", () => {
  assert.equal(resolveAgent({ readOnly: true }, { env: { TERRARIUM_READ_ONLY_AGENT: "pi -p --no-session --tools read,grep,find,ls" }, config: {} }), "pi -p --no-session --tools read,grep,find,ls");
  assert.equal(resolveAgent({ readOnly: true }, { env: {}, config: { readOnlyAgent: "pi -p --no-session --tools read,grep,find,ls" } }), "pi -p --no-session --tools read,grep,find,ls");
});

test("model resolution is explicit > env > config > runner default", () => {
  assert.equal(resolveModel({ model: "explicit/model" }, { env: { TERRARIUM_MODEL: "env/model" }, config: { defaultModel: "config/model" } }), "explicit/model");
  assert.equal(resolveModel({}, { env: { TERRARIUM_MODEL: "env/model" }, config: { defaultModel: "config/model" } }), "env/model");
  assert.equal(resolveModel({}, { env: {}, config: { defaultModel: "config/model" } }), "config/model");
  assert.equal(resolveModel({}, { env: {}, config: {} }), null);
});

test("model is applied to opencode and pi child commands", () => {
  assert.equal(applyModelToAgent("opencode run --agent explore", "anthropic/claude-sonnet-4-6"), "opencode run --agent explore --model anthropic/claude-sonnet-4-6");
  assert.equal(applyModelToAgent("pi -p --no-session", "kindle-alpha"), "pi -p --no-session --model kindle-alpha");
  assert.throws(() => applyModelToAgent("custom-agent", "x"), /supported for/);
  assert.equal(applyModelToAgent("custom-agent", "config-default", { strict: false }), "custom-agent");
  assert.throws(() => applyModelToAgent("pi -p --model old", "new"), /already contains a model flag/);
});

test("runTerrarium dry-run wires readOnly preset into the child invocation when no agent is given", async () => {
  const result = await runTerrarium({ task: "dig", readOnly: true, dryRun: true, stream: false, config: {} });
  assert.equal(result.ok, true);
  assert.equal(result.agent, "opencode run --agent explore");
  assert.equal(result.readOnly, true);
  assert.match(result.invocation, /opencode run --agent explore /);
});

test("runTerrarium dry-run: explicit --agent overrides readOnly preset", async () => {
  const result = await runTerrarium({ task: "dig", agent: "pi run", readOnly: true, dryRun: true, stream: false, config: {} });
  assert.equal(result.agent, "pi run");
  assert.equal(result.readOnly, false);
  assert.match(result.invocation, /^pi run /);
});

test("runTerrarium dry-run records and pins a Pi model", async () => {
  const result = await runTerrarium({ task: "dig", agent: "pi -p --no-session", model: "kindle-alpha", dryRun: true, stream: false, config: {} });
  assert.equal(result.model, "kindle-alpha");
  assert.equal(result.agent, "pi -p --no-session --model kindle-alpha");
  assert.match(result.invocation, /^pi -p --no-session --model kindle-alpha /);
});

test("runTerrarium dry-run minimal profile produces a leaner child invocation", async () => {
  const def = await runTerrarium({ task: "dig", profile: "default", dryRun: true, stream: false, config: {} });
  const min = await runTerrarium({ task: "dig", profile: "minimal", dryRun: true, stream: false, config: {} });
  assert.equal(def.profile, "default");
  assert.equal(min.profile, "minimal");
  assert.ok(min.invocation.length < def.invocation.length, `minimal invocation (${min.invocation.length}) should be shorter than default (${def.invocation.length})`);
  assert.match(min.invocation, /Single bounded task\. Do not spawn subagents\./);
  assert.doesNotMatch(min.invocation, /You are a Terrarium child agent/);
});

test("runTerrarium rejects an unknown profile name", async () => {
  await assert.rejects(() => runTerrarium({ task: "x", profile: "tiny", dryRun: true, stream: false, config: {} }), /unknown prompt profile/);
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


test("rejects run traversal, external logs, and child depth escalation", async () => {
  assert.throws(() => assertRunId("../../outside"), /invalid Terrarium run id/);
  await assert.rejects(() => runTerrarium({ task: "noop", dryRun: true, runId: "../../outside" }), /invalid Terrarium run id/);
  await assert.rejects(() => runTerrarium({ task: "noop", dryRun: true, logPath: join(tmpdir(), "outside.log") }), /must stay inside/);
  const previousDepth = process.env.TERRARIUM_DEPTH;
  const previousMax = process.env.TERRARIUM_MAX_DEPTH;
  try {
    process.env.TERRARIUM_DEPTH = "1";
    process.env.TERRARIUM_MAX_DEPTH = "1";
    await assert.rejects(() => runTerrarium({ task: "noop", dryRun: true, maxDepth: 999 }), /cannot raise inherited/);
    await assert.rejects(() => runTerrarium({ task: "noop", dryRun: true, depth: -100 }), /invalid Terrarium depth/);
  } finally {
    if (previousDepth === undefined) delete process.env.TERRARIUM_DEPTH; else process.env.TERRARIUM_DEPTH = previousDepth;
    if (previousMax === undefined) delete process.env.TERRARIUM_MAX_DEPTH; else process.env.TERRARIUM_MAX_DEPTH = previousMax;
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

test("records git metadata when cwd is a repo and null when it is not", async () => {
  const repo = mkdtempSync(join(tmpdir(), "terra-git-meta-"));
  const nonRepo = mkdtempSync(join(tmpdir(), "terra-no-git-"));
  try {
    initRepo(repo);
    const inRepo = await spawnTerrariumBackground({ task: "noop", dryRun: true, cwd: repo, agent: "node -e \"process.exit(0)\"" });
    assert.ok(inRepo.git, "expected git metadata when cwd is a repo");
    assert.equal(typeof inRepo.git.root, "string");
    assert.ok(inRepo.git.root.length > 0);
    assert.match(inRepo.git.head ?? "", /^[0-9a-f]{7,}/);
    assert.equal(typeof inRepo.git.status, "string");

    const outside = await spawnTerrariumBackground({ task: "noop", dryRun: true, cwd: nonRepo, agent: "node -e \"process.exit(0)\"" });
    assert.equal(outside.git, null);
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(nonRepo, { recursive: true, force: true }); } catch {}
  }
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
