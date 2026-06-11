import test from "node:test";
import assert from "node:assert/strict";
import { adaptivePrompt, parseAdaptivePayload, runAdaptiveCampaign } from "../src/adaptive.js";
import { DEFAULT_LAB_POLICY } from "../src/lab.js";

test("adaptive payload contract is strict", () => {
  assert.match(adaptivePrompt({ scenarioId: "lab-env-canary", turn: 1, maxTurns: 3 }), /TERRARIUM_PAYLOAD=/);
  assert.deepEqual(parseAdaptivePayload('TERRARIUM_PAYLOAD={"body":"return false;","capabilities":[],"hypothesis":"probe"}', DEFAULT_LAB_POLICY), { body: "return false;", capabilities: [], hypothesis: "probe" });
  assert.throws(() => parseAdaptivePayload("nope", DEFAULT_LAB_POLICY), /missing/);
});

test("adaptive campaign stops on verified escape", async () => {
  let proposals = 0;
  let runs = 0;
  const result = await runAdaptiveCampaign({
    scenarioId: "lab-env-canary",
    turns: 3,
    baseUrl: "https://lab.example",
    propose: async () => { proposals++; return 'TERRARIUM_PAYLOAD={"body":"return true;","capabilities":[],"hypothesis":"probe"}'; },
    fetcher: async () => ({ ok: true, json: async () => ({ ok: true, result: true, resultId: `r${++runs}` }) }),
    policy: DEFAULT_LAB_POLICY,
  });
  assert.equal(result.finalVerdict, "verified-escape");
  assert.equal(result.turnsUsed, 1);
  assert.equal(proposals, 1);
  assert.equal(runs, 2);
});
