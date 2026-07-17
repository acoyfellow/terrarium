import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { applyModelToAgent, assertRunId, capturePatch, childPrompt, classifyRunnerFailure, defaultMreLogPath, finalizeWorkspace, getRunStatus, isPidAlive, materializePromptTransport, prepareWorkspace, PROMPT_ARG_MAX_BYTES, readRun, reconcileRun, resolveAgent, resolveModel, resolvePromptProfile, runTerrarium, spawnTerrariumBackground, splitCommand, validateTaskContractOutput, READ_ONLY_AGENT } from "../src/core.js";
import { clearInheritedTerrariumEnv } from "./helpers/terrarium-env.js";

clearInheritedTerrariumEnv();

test("builds a constrained child prompt", () => {
  assert.match(childPrompt("ship it", { depth: 1, maxDepth: 3 }), /Do not fan out/);
  assert.deepEqual(splitCommand('node -e "console.log(1)"'), ["node", "-e", "console.log(1)"]);
});

test("large child prompts are materialized to a file instead of argv", async () => {
  const run = { runId: `ter_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` };
  const prompt = "x".repeat(PROMPT_ARG_MAX_BYTES + 100);
  const transport = await materializePromptTransport(run, prompt);
  try {
    assert.equal(transport.promptTransport, "file");
    assert.ok(transport.promptArg.length < 512);
    assert.equal(readFileSync(transport.promptPath, "utf8"), prompt);
  } finally {
    if (transport.promptPath) rmSync(transport.promptPath, { force: true });
  }
});

test("task receipt validation classifies non-object JSON as malformed", () => {
  const expected = { runId: "run-1", taskFingerprint: "fingerprint", nonce: "nonce" };
  for (const value of ["null", "[]", '"receipt"', "42"]) {
    assert.deepEqual(validateTaskContractOutput(`TERRARIUM_RESULT=${value}`, expected), { status: "malformed" });
  }
});

test("task receipt validation only accepts column-zero result markers", () => {
  const expected = { runId: "run-1", taskFingerprint: "fingerprint", nonce: "nonce" };
  const receipt = JSON.stringify({ ...expected, summary: "done" });
  for (const prefix of [" ", "\t", "log: ", "x"]) {
    assert.deepEqual(validateTaskContractOutput(`${prefix}TERRARIUM_RESULT=${receipt}`, expected), { status: "missing" });
  }
  assert.deepEqual(
    validateTaskContractOutput(`quoted marker: TERRARIUM_RESULT={not-json}\nTERRARIUM_RESULT=${receipt}`, expected),
    { status: "verified", summary: "done" },
  );
});

test("task receipt validation recognizes CR and Unicode line separators", () => {
  const expected = { runId: "run-1", taskFingerprint: "fingerprint", nonce: "nonce" };
  const receipt = JSON.stringify({ ...expected, summary: "done" });
  for (const separator of ["\r", "\u2028", "\u2029"]) {
    assert.deepEqual(
      validateTaskContractOutput(`progress${separator}TERRARIUM_RESULT=${receipt}${separator}finished`, expected),
      { status: "verified", summary: "done" },
    );
  }
  assert.deepEqual(
    validateTaskContractOutput(`TERRARIUM_RESULT=${receipt}\rTERRARIUM_RESULT=${receipt}`, expected),
    { status: "malformed" },
  );
});

test("task receipt validation enforces summary boundaries and preserves JSON text", () => {
  const expected = { runId: "run-1", taskFingerprint: "fingerprint", nonce: "nonce" };
  const output = (summary, extra = {}) => `TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary, ...extra })}`;

  assert.deepEqual(validateTaskContractOutput(output(" x ".padEnd(2001, "a")), expected), { status: "malformed" });
  assert.deepEqual(validateTaskContractOutput(output("a".repeat(2000)), expected), { status: "verified", summary: "a".repeat(2000) });
  assert.deepEqual(validateTaskContractOutput(output("  done ✅\n第二行  "), expected), { status: "verified", summary: "done ✅\n第二行" });
  assert.deepEqual(validateTaskContractOutput(output("done", { evidenceRef: "https://attacker.invalid", arbitrary: { trusted: true } }), expected), { status: "malformed" });
  assert.deepEqual(validateTaskContractOutput(`${output("first")}\n${output("second")}`, expected), { status: "malformed" });
});

test("task receipt validation rejects spoofing edge cases deterministically", () => {
  const expected = { runId: "run-1", taskFingerprint: "fingerprint", nonce: "nonce" };
  const valid = `TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary: "done" })}`;
  const polluted = `TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary: "done", __proto__: { admin: true }, constructor: { prototype: { admin: true } } })}`;

  assert.deepEqual(validateTaskContractOutput(polluted, expected), { status: "malformed" });
  assert.equal({}.admin, undefined);
  assert.deepEqual(validateTaskContractOutput(`TERRARIUM_RESULT={bad json}\n${valid}`, expected), { status: "malformed" });
  assert.deepEqual(validateTaskContractOutput(`TERRARIUM_RESULT=[]\n${valid}`, expected), { status: "malformed" });
  assert.deepEqual(validateTaskContractOutput(`TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary: "done", runIdPadding: "x".repeat(100_000) })}`, expected), { status: "malformed" });
});

test("task receipt validation caps ignored marker data and remains independent of stdout tail position", () => {
  const expected = { runId: "run-1", taskFingerprint: "fingerprint", nonce: "nonce" };
  const valid = `TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary: "done" })}`;
  const displaced = `${valid}\n${"x".repeat(200_000)}`;

  assert.deepEqual(validateTaskContractOutput(displaced, expected), { status: "verified", summary: "done" });
  assert.deepEqual(validateTaskContractOutput(displaced.slice(-4_000), expected), { status: "missing" });
  assert.deepEqual(validateTaskContractOutput(`TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary: "done", padding: "x".repeat(20_000) })}`, expected), { status: "malformed" });
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
  assert.equal(applyModelToAgent("pi -p --no-session", "test-model"), "pi -p --no-session --model test-model");
  assert.throws(() => applyModelToAgent("custom-agent", "x"), /supported for/);
  assert.equal(applyModelToAgent("custom-agent", "config-default", { strict: false }), "custom-agent");
  assert.throws(() => applyModelToAgent("pi -p --model old", "new"), /already contains a model flag/);
});

test("terminal run envelope links to durable callback journal event", async () => {
  const run = await runTerrarium({ task: "callback journal handle", dryRun: true, stream: false });
  const status = await getRunStatus({ runId: run.runId });
  assert.equal(status.status, "done");
  assert.equal(status.terminalCallback.eventId, `evt_${run.runId}_Completed`);
  assert.equal(typeof status.terminalCallback.delivered, "number");
  assert.equal(typeof status.terminalCallback.duplicate, "boolean");
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
  assert.equal(result.agent, "pi run --no-session");
  assert.equal(result.readOnly, false);
  assert.match(result.invocation, /^pi run --no-session /);
});

test("runner failures classify actionable Pi contention and opencode model configuration", () => {
  assert.deepEqual(classifyRunnerFailure({ agent: "pi -p", stderrTail: "Error: runner is busy; try again" }), { failureKind: "runner-busy", retryable: true });
  assert.deepEqual(classifyRunnerFailure({ agent: "/usr/local/bin/pi", error: "No available runners" }), { failureKind: "runner-busy", retryable: true });
  assert.deepEqual(classifyRunnerFailure({ agent: "pi -p", stderrTail: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." }), { failureKind: "runner-busy", retryable: true });
  assert.deepEqual(classifyRunnerFailure({ agent: "opencode run", stderrTail: "Error: model anthropic/missing not found" }), { failureKind: "model-configuration", retryable: false });
  assert.deepEqual(classifyRunnerFailure({ agent: "/usr/local/bin/opencode run", error: "Unknown model: bad/model" }), { failureKind: "model-configuration", retryable: false });
  assert.equal(classifyRunnerFailure({ agent: "opencode run", stderrTail: "runner is busy" }), null);
  assert.equal(classifyRunnerFailure({ agent: "pi -p", stderrTail: "unknown model: bad/model" }), null);
  assert.equal(classifyRunnerFailure({ agent: "opencode serve", stderrTail: "unknown model: bad/model" }), null);
  assert.equal(classifyRunnerFailure({ agent: "pi -p", stderrTail: "authentication failed" }), null);
});

test("Pi children default ephemeral but explicit session behavior is preserved", async () => {
  const ephemeral = await runTerrarium({ task: "dig", agent: "pi -p", dryRun: true, stream: false, config: {} });
  assert.match(ephemeral.agent, /--no-session/);
  const persistent = await runTerrarium({ task: "dig", agent: "pi -p --session-id chosen", dryRun: true, stream: false, config: {} });
  assert.doesNotMatch(persistent.agent, /--no-session/);
  const optedOut = await runTerrarium({ task: "dig", agent: "pi -p", ephemeral: false, dryRun: true, stream: false, config: {} });
  assert.doesNotMatch(optedOut.agent, /--no-session/);
});

test("Pi session agents are forced into print mode before Terrarium appends the prompt", async () => {
  const session = await runTerrarium({ task: "dig", agent: "pi --session 019ee47d-bfe9-7287-8c12-5400c71240b", dryRun: true, stream: false, config: {} });
  assert.equal(session.agent, "pi --session 019ee47d-bfe9-7287-8c12-5400c71240b --print");
  assert.doesNotMatch(session.agent, /--no-session/);
});

test("runTerrarium dry-run records and pins a Pi model", async () => {
  const result = await runTerrarium({ task: "dig", agent: "pi -p --no-session", model: "test-model", dryRun: true, stream: false, config: {} });
  assert.equal(result.model, "test-model");
  assert.equal(result.agent, "pi -p --no-session --model test-model");
  assert.match(result.invocation, /^pi -p --no-session --model test-model /);
});

test("runTerrarium dry-run minimal profile produces a leaner child invocation", async () => {
  const def = await runTerrarium({ task: "dig", profile: "default", dryRun: true, stream: false, config: {} });
  const min = await runTerrarium({ task: "dig", profile: "minimal", dryRun: true, stream: false, config: {} });
  assert.equal(def.profile, "default");
  assert.equal(min.profile, "minimal");
  assert.equal(def.allowSpawn, true);
  assert.equal(def.statusScope, "descendants");
  assert.equal(def.readScope, "descendants");
  assert.equal(min.allowSpawn, false);
  assert.equal(min.statusScope, "self");
  assert.equal(min.readScope, "self");
  assert.ok(min.invocation.length < def.invocation.length, `minimal invocation (${min.invocation.length}) should be shorter than default (${def.invocation.length})`);
  assert.match(min.invocation, /Single bounded task\. Do not spawn subagents\./);
  assert.doesNotMatch(min.invocation, /You are a Terrarium child agent/);
});

test("callback correlation defaults to caller cwd and accepts explicit safe identifiers", async () => {
  const callerChannel = process.cwd().split("/").at(-1);
  const implicit = await runTerrarium({ task: "callback correlation", cwd: tmpdir(), dryRun: true, stream: false });
  assert.equal(implicit.channel, callerChannel);
  assert.notEqual(implicit.channel, tmpdir().split("/").at(-1));
  const explicit = await runTerrarium({ task: "callback correlation explicit", dryRun: true, stream: false, channel: "parent-channel", workflowId: "workflow_1", sessionId: "session_1" });
  assert.equal(explicit.channel, "parent-channel");
  assert.equal(explicit.workflowId, "workflow_1");
  assert.equal(explicit.sessionId, "session_1");
  await assert.rejects(() => runTerrarium({ task: "bad channel", dryRun: true, stream: false, channel: "../outside" }), /invalid Terrarium channel/);
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
    assert.equal(marker.source, undefined);

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
    mkdirSync(join(workspace.path, "nested"));
    writeFileSync(join(workspace.path, "nested", ".terrarium-workspace"), "source=/private/secret\n");
    writeFileSync(join(workspace.path, "nested", ".env"), "PLANTED_CANARY=safe-test-value\n");
    const diff = await capturePatch(workspace.path);
    assert.equal(diff.code, 0);
    assert.match(diff.stdout, /tracked\.txt/);
    assert.match(diff.stdout, /fresh\.txt/);
    assert.match(diff.stdout, /brand new/);
    assert.match(diff.stdout, /nested\/\.env/);
    assert.match(diff.stdout, /PLANTED_CANARY=safe-test-value/);
    assert.doesNotMatch(diff.stdout, /\.terrarium-workspace/);
    assert.doesNotMatch(diff.stdout, /private\/secret/);
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

async function waitForTerminal(runId, { staleMs = 5000, attempts = 100, delayMs = 50, requireTerminalCallback = false } = {}) {
  let status;
  for (let i = 0; i < attempts; i++) {
    status = await getRunStatus({ runId, staleMs });
    if (status.status !== "running" && (!requireTerminalCallback || status.terminalCallback)) return status;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return status;
}

test("background runs finish after the launcher exits", async () => {
  const coreUrl = new URL("../src/core.js", import.meta.url).href;
  const agent = `${process.execPath} -e "setTimeout(() => console.log('supervised child complete'), 80)"`;
  const launcher = `import { spawnTerrariumBackground } from ${JSON.stringify(coreUrl)};\nconst result = await spawnTerrariumBackground(${JSON.stringify({ task: "finish independently", agent })});\nconsole.log(JSON.stringify({ runId: result.runId }));`;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", launcher], { encoding: "utf8" });
  const { runId } = JSON.parse(output.trim());
  const status = await waitForTerminal(runId);
  assert.equal(status.status, "done");
  assert.equal(status.exitCode, 0);
  assert.match(status.stdoutTail, /supervised child complete/);
  const log = await readRun({ runId });
  assert.match(log.text, /supervised child complete/);
});

test("background large prompt uses prompt file transport and still verifies receipt", async () => {
  const script = "const fs=require('fs');const arg=process.argv.at(-1);if(arg.length>512)throw new Error('prompt argv was too large');if(process.env.TERRARIUM_PROMPT_TRANSPORT!=='file')throw new Error('expected file transport');const prompt=fs.readFileSync(process.env.TERRARIUM_PROMPT_FILE,'utf8');if(!prompt.includes('LARGE_PROMPT_SENTINEL'))throw new Error('missing large prompt content');const line=prompt.split('\n').find((value)=>value.includes('TERRARIUM_RESULT='));const receipt=JSON.parse(line.slice(line.indexOf('TERRARIUM_RESULT=')+'TERRARIUM_RESULT='.length));receipt.summary='large prompt received';console.log('PROMPT_FILE_BYTES='+Buffer.byteLength(prompt));console.log('TERRARIUM_RESULT='+JSON.stringify(receipt));";
  const agent = `${process.execPath} -e ${JSON.stringify(script)}`;
  const task = `LARGE_PROMPT_SENTINEL\n${"x".repeat(PROMPT_ARG_MAX_BYTES + 3000)}`;
  const started = await spawnTerrariumBackground({ task, agent, timeoutMs: 5000, requireTaskContract: true });
  const status = await waitForTerminal(started.runId, { attempts: 120 });
  assert.equal(status.status, "done");
  assert.equal(status.taskContractStatus, "verified");
  assert.equal(status.taskResultSummary, "large prompt received");
  assert.equal(status.terminalCallback?.eventId, `evt_${started.runId}_Completed`);
  assert.match(status.stdoutTail, /PROMPT_FILE_BYTES=/);
});

test("background wedged-but-alive child is killed at the startup hard ceiling", async () => {
  const prevWin = process.env.TERRARIUM_STARTUP_WATCHDOG_MS;
  const prevCeil = process.env.TERRARIUM_STARTUP_HARD_CEILING_MS;
  try {
    // Alive but permanently silent (no stdout, no log growth). The base window no
    // longer kills a live child; the hard ceiling does.
    process.env.TERRARIUM_STARTUP_WATCHDOG_MS = "200";
    process.env.TERRARIUM_STARTUP_HARD_CEILING_MS = "800";
    const agent = `${process.execPath} -e "setInterval(() => {}, 1000)"`;
    const started = await spawnTerrariumBackground({ task: "hang before output", agent, timeoutMs: 10000 });
    const status = await waitForTerminal(started.runId, { attempts: 200, delayMs: 25 });
    assert.equal(status.status, "error");
    assert.equal(status.ok, false);
    assert.equal(status.exitCode, 124);
    assert.match(status.error, /hard ceiling/);
    assert.equal(status.terminalCallback?.eventId, `evt_${started.runId}_Failed`);
    const log = await readRun({ runId: started.runId });
    assert.match(log.text, /startup-timeout/);
  } finally {
    if (prevWin === undefined) delete process.env.TERRARIUM_STARTUP_WATCHDOG_MS; else process.env.TERRARIUM_STARTUP_WATCHDOG_MS = prevWin;
    if (prevCeil === undefined) delete process.env.TERRARIUM_STARTUP_HARD_CEILING_MS; else process.env.TERRARIUM_STARTUP_HARD_CEILING_MS = prevCeil;
  }
});

test("background alive log-growing child survives the base startup window (no false kill)", async () => {
  const prevWin = process.env.TERRARIUM_STARTUP_WATCHDOG_MS;
  const prevCeil = process.env.TERRARIUM_STARTUP_HARD_CEILING_MS;
  try {
    // The reported false-kill scenario: alive and productive (growing its run log
    // via stderr) but slow to first stdout. Must NOT be killed by the base window.
    // It stays silent-on-stdout past the window, then completes successfully.
    process.env.TERRARIUM_STARTUP_WATCHDOG_MS = "200";
    process.env.TERRARIUM_STARTUP_HARD_CEILING_MS = "5000";
    // Write to stderr (grows run.log) for 600ms (3x window), THEN emit the receipt on stdout.
    const script = "let n=0;const t=setInterval(()=>{process.stderr.write('working '+(++n)+'\\n');if(n>=6){clearInterval(t);console.log('done');process.exit(0);}},100);";
    const agent = `${process.execPath} -e "${script}"`;
    const started = await spawnTerrariumBackground({ task: "slow first stdout", agent, timeoutMs: 10000 });
    const status = await waitForTerminal(started.runId, { attempts: 400, delayMs: 25 });
    // Survived the base window and finished on its own terms (not a startup kill).
    assert.ok(!/startup-timeout/.test(String(status.error || "")), `should not be startup-killed, got: ${status.error}`);
    const log = await readRun({ runId: started.runId });
    assert.ok(!/startup-timeout/.test(log.text), "log must not record a startup-timeout");
    assert.match(log.text, /working 6/);
  } finally {
    if (prevWin === undefined) delete process.env.TERRARIUM_STARTUP_WATCHDOG_MS; else process.env.TERRARIUM_STARTUP_WATCHDOG_MS = prevWin;
    if (prevCeil === undefined) delete process.env.TERRARIUM_STARTUP_HARD_CEILING_MS; else process.env.TERRARIUM_STARTUP_HARD_CEILING_MS = prevCeil;
  }
});

test("background deadline timeout terminalizes and journals callback", async () => {
  // The child prints, waits long enough that its stdout reliably flushes to
  // stdoutTail even under concurrent test load, THEN the deadline kills it. A
  // too-tight deadline (was 250ms) raced the async stdout handler and
  // intermittently asserted an empty stdoutTail. 2000ms keeps the SAME assertions
  // (output captured, then deadline-killed) without the flush race.
  const agent = `${process.execPath} -e "console.log('child started'); setInterval(() => {}, 1000)"`;
  const started = await spawnTerrariumBackground({ task: "timeout after output", agent, timeoutMs: 2000 });
  const status = await waitForTerminal(started.runId, { attempts: 400, delayMs: 25, requireTerminalCallback: true });
  assert.equal(status.status, "failed");
  assert.equal(status.ok, false);
  assert.equal(status.taskContractStatus, "not-applicable");
  assert.equal(status.terminalCallback?.eventId, `evt_${started.runId}_Failed`);
  assert.match(status.stdoutTail, /child started/);
});

test("reconcileRun reports factual needs-attention after output inactivity", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "terra-attention-"));
  const logPath = join(logDir, "run.log");
  writeFileSync(logPath, "quiet");
  try {
    const meta = { runId: "ter_test_attention", status: "running", pid: process.pid, logPath, startedAt: new Date(Date.now() - 10000).toISOString(), lastActivityAt: new Date(Date.now() - 10000).toISOString(), needsAttentionAfterMs: 5000 };
    const result = await reconcileRun(meta);
    assert.equal(result.alive, true);
    assert.equal(result.needsAttention, true);
    assert.ok(result.idleMs >= 5000);
  } finally { rmSync(logDir, { recursive: true, force: true }); }
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

test("reconcileRun orphans a stale run when only the supervisor pid remains alive", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "terra-supervisor-only-"));
  const logPath = join(logDir, "run.log");
  writeFileSync(logPath, "old log");
  const meta = { runId: "ter_test_supervisor_only", status: "running", pid: 99999996, childPid: 99999996, supervisorPid: process.pid, logPath };
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reconciled = await reconcileRun(meta, { staleMs: 0 });
  try {
    assert.equal(reconciled.status, "orphaned");
    assert.equal(reconciled.ok, false);
    assert.match(reconciled.note, /No live Terrarium child process/);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
    rmSync(join(homedir(), ".terrarium", "runs", "ter_test_supervisor_only.json"), { force: true });
  }
});

test("reconcileRun normalizes a pending task contract to not-applicable when orphaning", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "terra-orphan-contract-"));
  const logPath = join(logDir, "run.log");
  writeFileSync(logPath, "old log");
  // A receipt-requiring run whose supervisor died before classification leaves
  // taskContractStatus "pending". A terminal run must never report "pending":
  // it lies to group roll-ups / mcp retry / the Pi extension that evaluation
  // continues. It must also not retain contract secret material.
  const meta = {
    runId: "ter_test_orphan_pending",
    status: "running",
    pid: 99999998,
    logPath,
    taskContractStatus: "pending",
    taskContract: { runId: "ter_test_orphan_pending", taskFingerprint: "abc", nonce: "secret-nonce" },
  };
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reconciled = await reconcileRun(meta, { staleMs: 0 });
  try {
    assert.equal(reconciled.status, "orphaned");
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.taskContractStatus, "not-applicable");
    assert.equal(reconciled.taskContract, undefined);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("reconcileRun refuses to propagate a verified contract claim from an unfinalized orphan", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "terra-orphan-verified-"));
  const logPath = join(logDir, "run.log");
  writeFileSync(logPath, "old log");
  // Defense in depth: a still-"running" record claiming a verified receipt was
  // never finalized through the run machine, so its success claim is untrusted.
  // Orphaning must not let that unverified "verified" survive as operational truth.
  const meta = { runId: "ter_test_orphan_verified", status: "running", pid: 99999997, logPath, taskContractStatus: "verified" };
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reconciled = await reconcileRun(meta, { staleMs: 0 });
  try {
    assert.equal(reconciled.status, "orphaned");
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.taskContractStatus, "not-applicable");
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("reconcileRun preserves an already-classified failed contract status when orphaning", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "terra-orphan-mismatch-"));
  const logPath = join(logDir, "run.log");
  writeFileSync(logPath, "old log");
  // A real classification (mismatch/missing/malformed) is durable operational
  // truth and must survive orphaning unchanged.
  const meta = { runId: "ter_test_orphan_mismatch", status: "running", pid: 99999996, logPath, taskContractStatus: "mismatch" };
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reconciled = await reconcileRun(meta, { staleMs: 0 });
  try {
    assert.equal(reconciled.status, "orphaned");
    assert.equal(reconciled.taskContractStatus, "mismatch");
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});
