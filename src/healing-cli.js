import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitCommand } from "./core.js";
import { validateFixPatch } from "./fix-policy.js";

function git(args, cwd, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: options.stdio || ["ignore", "pipe", "pipe"] }).trim();
}
function gh(args, cwd) {
  return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function runAgent(command, prompt, cwd, timeoutMs) {
  const parts = splitCommand(command);
  return new Promise((resolve, reject) => {
    const child = spawn(parts[0], [...parts.slice(1), prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr || `fixer exited ${code}`)); });
  });
}

export function fixerPrompt({ issueNumber, finding }) {
  return `You are the constrained Terrarium repair agent for verified finding #${issueNumber}.

Affected revision: ${finding.sourceRevision}
Scenario: ${finding.scenarioId}
Frozen payload hash: ${finding.payloadHash}
Sanitized result: ${finding.result}

Work only in this issue-scoped git worktree. Implement the smallest product fix and add a regression test under test/*.test.js.
Do not modify workflows, trusted detectors, evidence/redaction policy, fix policy, threat model, compatibility contract, or deployment configuration.
Do not weaken/remove tests. Do not commit, push, open PRs, merge, or access secrets. The trusted controller performs those actions after validating your patch.`;
}

export async function runHealingLoop({ repo = process.cwd(), issueNumber, finding, agent = "pi -p --no-session", model, timeoutMs = 300000, dryRun = false } = {}) {
  if (!issueNumber || !finding?.sourceRevision || !finding?.payloadHash || !finding?.scenarioId) throw new Error("verified finding, source revision, payload hash, scenario, and issue number required");
  if (finding.verdict !== "verified-escape") throw new Error("healing loop requires verified escape");
  const branch = `terrarium/fix/${issueNumber}-${finding.scenarioId.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
  const workspace = await mkdtemp(join(tmpdir(), "terrarium-fix-"));
  try {
    git(["worktree", "add", "--detach", workspace, finding.sourceRevision], repo);
    git(["switch", "-c", branch], workspace);
    const command = model ? `${agent} --model ${model}` : agent;
    if (dryRun) return { dryRun: true, branch, workspace, command, prompt: fixerPrompt({ issueNumber, finding }) };
    await runAgent(command, fixerPrompt({ issueNumber, finding }), workspace, timeoutMs);
    const base = git(["merge-base", "HEAD", finding.sourceRevision], workspace);
    const patch = git(["diff", "--binary", finding.sourceRevision], workspace);
    const validation = validateFixPatch({ patch, baseRevision: base, expectedBaseRevision: finding.sourceRevision });
    const patchFile = join(workspace, ".terrarium-validated.patch");
    await writeFile(patchFile, patch);
    git(["add", "-A"], workspace);
    git(["reset", "--", ".terrarium-validated.patch"], workspace);
    git(["commit", "-m", `Fix verified escape #${issueNumber}`], workspace);
    git(["push", "-u", "origin", branch], workspace);
    const prUrl = gh(["pr", "create", "--repo", "acoyfellow/terrarium", "--base", "main", "--head", branch, "--title", `[verified escape] Fix #${issueNumber}`, "--body", `Fixes #${issueNumber}\n\nValidated patch: \`${validation.patchDigest}\`\nFrozen payload: \`${finding.payloadHash}\`\nAffected revision: \`${finding.sourceRevision}\`\n\nMerge is allowed only after trusted tests and exact frozen-payload replay report contained.`], workspace);
    return { branch, prUrl, validation, patch: await readFile(patchFile, "utf8") };
  } finally {
    try { git(["worktree", "remove", "--force", workspace], repo); } catch { await rm(workspace, { recursive: true, force: true }); }
  }
}
