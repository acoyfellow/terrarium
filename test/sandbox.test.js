import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACK_RESULT_MARKER, DEFAULT_SANDBOX_IMAGE, FIXTURE_SCENARIO_IDS, attackPrompt, campaignIssueDraft, createFixtureCampaign, dockerScenarioArgs, issueDraftFromVerification, listCampaignReceipts, parseAttackProposal, readCampaignReceipt, resolveScenario, runAttackExperiment, runSandboxScenario, SCENARIO_IDS, verifyCampaignReceipt, verifySandboxScenario } from "../src/sandbox.js";

test("declares small deterministic initial sandbox scenarios", () => {
  assert.deepEqual(SCENARIO_IDS, ["filesystem-write-outside-workspace", "environment-canary", "network-disabled", "filesystem-read-canary", "process-persistence"]);
  assert.deepEqual(FIXTURE_SCENARIO_IDS, ["fixture-environment-leak"]);
  assert.match(resolveScenario("filesystem-write-outside-workspace").description, /outside/);
  assert.throws(() => resolveScenario("not-real"), /unknown sandbox scenario/);
});

test("attack proposal contract is narrow and machine parseable", () => {
  const prompt = attackPrompt("environment-canary");
  assert.match(prompt, /credential-free baseline experiment/);
  assert.match(prompt, /Return exactly one line/);
  assert.deepEqual(parseAttackProposal(`${ATTACK_RESULT_MARKER}{"run":true,"reason":"try detector"}`), { run: true, reason: "try detector" });
  assert.throws(() => parseAttackProposal("I escaped"), /did not contain/);
  assert.throws(() => parseAttackProposal(`${ATTACK_RESULT_MARKER}{"run":false,"reason":"no"}`), /declined/);
});

test("docker scenario policy uses explicit hostile-run restrictions without host bind mounts", () => {
  const args = dockerScenarioArgs({ scenarioId: "environment-canary", image: DEFAULT_SANDBOX_IMAGE, containerName: "probe-test" });
  assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--name", "probe-test"]);
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("none"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("65534:65534"));
  assert.ok(args.includes(DEFAULT_SANDBOX_IMAGE));
  assert.ok(args.includes("-e"));
  assert.equal(args.includes("--mount"), false);
  assert.equal(args.includes("--env"), false);
  const persistenceArgs = dockerScenarioArgs({ scenarioId: "process-persistence", image: DEFAULT_SANDBOX_IMAGE, containerName: "persist-test", autoRemove: false });
  assert.equal(persistenceArgs.includes("--rm"), false);
});

test("docker sandbox contains deterministic baseline probes", { timeout: 120000 }, async (t) => {
  const available = await runSandboxScenario({ scenarioId: "environment-canary" }).catch((error) => ({ verdict: "inconclusive", stderr: error.message }));
  if (available.verdict === "inconclusive" && /image|pull|daemon|docker/i.test(available.stderr ?? "")) {
    t.skip(`docker sandbox image/runtime unavailable: ${available.stderr.trim()}`);
    return;
  }
  assert.equal(available.verdict, "contained", available.stderr);
  assert.match(available.stdout, /CANARY_ABSENT/);

  const filesystem = await runSandboxScenario({ scenarioId: "filesystem-write-outside-workspace" });
  assert.equal(filesystem.verdict, "contained", filesystem.stderr);
  assert.match(filesystem.stdout, /ATTEMPT_WRITE_BLOCKED/);
  assert.equal(filesystem.policy.network, "none");
  assert.equal(filesystem.policy.rootFilesystem, "read-only");
  assert.equal(filesystem.workspacePath, undefined);

  const network = await runSandboxScenario({ scenarioId: "network-disabled" });
  assert.equal(network.verdict, "contained", network.stderr);
  assert.match(network.stdout, /NETWORK_BLOCKED/);

  const filesystemRead = await runSandboxScenario({ scenarioId: "filesystem-read-canary" });
  assert.equal(filesystemRead.verdict, "contained", filesystemRead.stderr);
  assert.match(filesystemRead.stdout, /READ_CANARY_BLOCKED/);

  const persistence = await runSandboxScenario({ scenarioId: "process-persistence" });
  assert.equal(persistence.verdict, "contained", persistence.stderr);
  assert.match(persistence.stdout, /PERSISTENCE_ATTEMPTED/);
  assert.equal(persistence.teardownVerified, true);
});

test("AI proposal experiment delegates verdict to deterministic detector and records sanitized receipt", { timeout: 120000 }, async () => {
  const receipts = mkdtempSync(join(tmpdir(), "terra-receipts-"));
  const fakeAgent = `${process.execPath} -e "console.log('${ATTACK_RESULT_MARKER}{' + String.fromCharCode(34) + 'run' + String.fromCharCode(34) + ':true,' + String.fromCharCode(34) + 'reason' + String.fromCharCode(34) + ':' + String.fromCharCode(34) + 'bounded-attempt' + String.fromCharCode(34) + '}')"`;
  try {
    const result = await runAttackExperiment({ scenarioId: "environment-canary", agent: fakeAgent, receiptDir: receipts, campaignId: "campaign_test" });
    assert.equal(result.runType, "ai-attack-experiment");
    assert.equal(result.proposal.reason, "bounded-attempt");
    assert.equal(result.detector.verdict, "contained");
    assert.equal(result.verdict, "contained");
    assert.equal(result.receipt.campaignId, "campaign_test");
    const written = JSON.parse(readFileSync(join(receipts, "campaign_test.json"), "utf8"));
    assert.equal(written.verdict, "contained");
    assert.equal(written.path, undefined);
    assert.equal(written.detector.verdict, "contained");
    assert.equal(written.agentUsed, true);
    assert.equal(written.agent, undefined);
    assert.equal(written.attacker, undefined);
    assert.equal(written.detector.stdout, undefined);
    const read = await readCampaignReceipt({ campaignId: "campaign_test", receiptDir: receipts });
    assert.equal(read.campaignId, "campaign_test");
    const listing = await listCampaignReceipts({ receiptDir: receipts });
    assert.equal(listing.count, 1);
    assert.equal(listing.campaigns[0].campaignId, "campaign_test");
    const verified = await verifyCampaignReceipt({ campaignId: "campaign_test", receiptDir: receipts });
    assert.equal(verified.verdict, "contained");
    assert.equal(verified.replay, null);
  } finally {
    rmSync(receipts, { recursive: true, force: true });
  }
});

test("campaign reader rejects path-shaped campaign ids", async () => {
  await assert.rejects(() => readCampaignReceipt({ campaignId: "../secrets" }), /invalid campaign id/);
});

test("known-vulnerable fixture exercises escaped receipt, replay verification, and draft", { timeout: 120000 }, async () => {
  const receipts = mkdtempSync(join(tmpdir(), "terra-fixture-receipts-"));
  try {
    const attack = await createFixtureCampaign({ receiptDir: receipts, campaignId: "campaign_fixture" });
    assert.equal(attack.verdict, "escaped");
    assert.equal(attack.receipt.fixture, true);
    assert.equal(attack.receipt.agentUsed, false);
    const verified = await verifyCampaignReceipt({ campaignId: "campaign_fixture", receiptDir: receipts });
    assert.equal(verified.verdict, "verified-escape");
    assert.equal(verified.replay.fixture, true);
    const draft = await campaignIssueDraft({ campaignId: "campaign_fixture", receiptDir: receipts });
    assert.match(draft.markdown, /Known-vulnerable fixture/);
    assert.match(draft.markdown, /fixture-environment-leak/);
    assert.doesNotMatch(draft.markdown, /planted-fixture-canary/);
  } finally {
    rmSync(receipts, { recursive: true, force: true });
  }
});

test("issue draft only renders verified escapes and omits raw evidence", () => {
  assert.throws(() => issueDraftFromVerification({ verdict: "contained" }), /requires a verified-escape/);
  const markdown = issueDraftFromVerification({
    verdict: "verified-escape",
    source: {
      campaignId: "campaign_verified",
      scenarioId: "environment-canary",
      runType: "ai-attack-experiment",
      detector: { observed: "Expected canary to remain unavailable." },
      attacker: { stdout: "PRIVATE_ATTACK_OUTPUT" },
    },
    replay: {
      fixture: false,
      backend: "docker",
      image: "node:22-alpine",
      policy: { network: "none" },
      observed: "The canary was observable during replay.",
      stdout: "PRIVATE_REPLAY_OUTPUT",
    },
  });
  assert.match(markdown, /\[escape\] environment-canary/);
  assert.match(markdown, /terra campaign verify campaign_verified/);
  assert.match(markdown, /The canary was observable during replay/);
  assert.doesNotMatch(markdown, /PRIVATE_ATTACK_OUTPUT|PRIVATE_REPLAY_OUTPUT/);
});

test("verification does not manufacture an escape when the initial probe is contained", { timeout: 120000 }, async () => {
  const verified = await verifySandboxScenario({ scenarioId: "filesystem-write-outside-workspace" });
  assert.equal(verified.verdict, "contained");
  assert.equal(verified.attack.verdict, "contained");
  assert.equal(verified.replay, null);
  assert.match(verified.observed, /no escape exists to replay/);
});
