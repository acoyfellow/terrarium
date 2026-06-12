import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReplayBinding, validateFixPatch } from "./fix-policy.js";
import { runHostileLabScenario } from "./hostile.js";

function command(name, args, cwd) {
  return execFileSync(name, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function replayAndMerge({ repo = process.cwd(), prNumber, finding, baseUrl, authToken, policy, fetcher, merge = true } = {}) {
  if (!Number.isInteger(Number(prNumber)) || Number(prNumber) < 1) throw new Error("valid PR number required");
  if (finding?.verdict !== "verified-escape") throw new Error("replay gate requires verified escape");
  const pr = JSON.parse(command("gh", ["pr", "view", String(prNumber), "--repo", "acoyfellow/terrarium", "--json", "headRefOid,baseRefOid,headRefName,url"], repo));
  const workspace = await mkdtemp(join(tmpdir(), "terrarium-replay-"));
  try {
    command("git", ["worktree", "add", "--detach", workspace, pr.headRefOid], repo);
    const patch = command("git", ["diff", "--binary", finding.sourceRevision, pr.headRefOid], workspace);
    const validation = validateFixPatch({ patch, baseRevision: command("git", ["merge-base", pr.headRefOid, finding.sourceRevision], workspace), expectedBaseRevision: finding.sourceRevision });
    assertReplayBinding({ findingPayloadHash: finding.payloadHash, replayPayloadHash: finding.payloadHash, findingScenarioId: finding.scenarioId, replayScenarioId: finding.scenarioId, findingRevision: finding.sourceRevision, patchBaseRevision: validation.baseRevision });
    command("npm", ["test"], workspace);
    const replay = await runHostileLabScenario({ scenarioId: finding.scenarioId, body: finding.privatePayloadBody, capabilities: finding.capabilities || [], baseUrl, authToken, policy, fetcher });
    if ((replay.verifiedVerdict || replay.verdict) !== "contained") throw new Error("frozen attack remains reproducible after fix");
    const receipt = { prNumber: Number(prNumber), prUrl: pr.url, headRevision: pr.headRefOid, affectedRevision: finding.sourceRevision, payloadHash: finding.payloadHash, scenarioId: finding.scenarioId, patchDigest: validation.patchDigest, verdict: "contained", executionId: replay.execution?.resultId || null, replayedAt: new Date().toISOString() };
    await writeFile(join(workspace, ".terrarium-replay-receipt.json"), JSON.stringify(receipt, null, 2));
    if (merge) command("gh", ["pr", "merge", String(prNumber), "--repo", "acoyfellow/terrarium", "--squash", "--delete-branch"], workspace);
    return { merged: merge, validation, replay: receipt };
  } finally {
    try { command("git", ["worktree", "remove", "--force", workspace], repo); } catch { await rm(workspace, { recursive: true, force: true }); }
  }
}
