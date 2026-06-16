import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LAB_POLICY } from "../src/lab.js";
import { HOSTILE_SCENARIOS } from "../src/hostile.js";
import { readFileSync } from "node:fs";

const CONTROL_WORKER_SOURCE = readFileSync(new URL("../src/control-worker.js", import.meta.url), "utf8");

test("control worker fixture uses the internal Lab hostile scenario", () => {
  assert.ok(HOSTILE_SCENARIOS["lab-env-canary"]);
  assert.equal(HOSTILE_SCENARIOS["lab-env-canary"].fixtureBody, "return true;");
  assert.equal(DEFAULT_LAB_POLICY.allowIssuePublish, false);
  assert.equal(DEFAULT_LAB_POLICY.allowFixPr, false);
  assert.equal(DEFAULT_LAB_POLICY.allowAutoMerge, false);
});

test("control worker remains fixture-only and starts with bounded policy", () => {
  assert.equal(DEFAULT_LAB_POLICY.maxPayloadBytes, 4096);
  assert.equal(DEFAULT_LAB_POLICY.requireFreshReplay, true);
  assert.deepEqual(DEFAULT_LAB_POLICY.allowCapabilities, []);
});

test("manual real endpoint enforces the configured run budget before Lab execution", () => {
  assert.match(CONTROL_WORKER_SOURCE, /assertManualBudget\(policy, ledger\)/);
  assert.match(CONTROL_WORKER_SOURCE, /daily run cap reached/);
  assert.match(CONTROL_WORKER_SOURCE, /status: 429/);
  assert.match(CONTROL_WORKER_SOURCE, /counts\.runs \+= 1/);
});

test("real campaigns serialize through a single durable-object lock", () => {
  assert.match(CONTROL_WORKER_SOURCE, /export class CampaignLock/);
  assert.match(CONTROL_WORKER_SOURCE, /campaign already running/);
  assert.match(CONTROL_WORKER_SOURCE, /withCampaignLock\(env, async/g);
  const lockUses = CONTROL_WORKER_SOURCE.match(/withCampaignLock\(env, async/g) || [];
  assert.ok(lockUses.length >= 2, "both real endpoints must hold the lock");
});

test("healing endpoint accepts only repository-scoped, digest-backed findings", () => {
  assert.match(CONTROL_WORKER_SOURCE, /\/campaigns\/healing/);
  assert.match(CONTROL_WORKER_SOURCE, /invalid evidence digest/);
  assert.match(CONTROL_WORKER_SOURCE, /github\\\.com\\\/acoyfellow\\\/terrarium/);
  assert.match(CONTROL_WORKER_SOURCE, /status: "merged"/);
  assert.match(CONTROL_WORKER_SOURCE, /autonomous healing requires a repository pull request/);
  assert.match(CONTROL_WORKER_SOURCE, /early-manual/);
});

test("publish endpoint re-sanitizes receipts and refuses fixtures", () => {
  assert.match(CONTROL_WORKER_SOURCE, /\/campaigns\/publish/);
  assert.match(CONTROL_WORKER_SOURCE, /requireAuthorization\(request, env\); if \(denied\) return denied;[\s\S]*campaigns\/publish|campaigns\/publish[\s\S]*requireAuthorization/);
  assert.match(CONTROL_WORKER_SOURCE, /fixture receipts cannot be published/);
  assert.match(CONTROL_WORKER_SOURCE, /publicSummary\(receipt\.scenarioId/);
  assert.match(CONTROL_WORKER_SOURCE, /hypothesis: summary\.hypothesis/);
  assert.doesNotMatch(CONTROL_WORKER_SOURCE, /hypothesis: body\.hypothesis/);
});

test("real-mode payload shape is bounded by the same hostile scenario contract", () => {
  const scenario = HOSTILE_SCENARIOS["lab-env-canary"];
  assert.equal(scenario.body, "return typeof secret !== 'undefined';");
  assert.deepEqual(scenario.capabilities, []);
});
