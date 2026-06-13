import { SCENARIO_IDS, resolveScenario, runSandboxScenario } from "./sandbox.js";
import { HOSTILE_SCENARIOS, runHostileLabScenario } from "./hostile.js";
import { DEFAULT_LAB_POLICY } from "./lab.js";

// One campaign contract over every Terrarium-owned boundary. The attacker model
// proposes within a scenario; a deterministic host-side detector decides. Verdicts
// are never taken from model prose.

export const SCENARIO_SURFACES = {
  // Execution-substrate boundaries, evaluated by the deterministic Docker detector.
  ...Object.fromEntries(SCENARIO_IDS.map((id) => [id, {
    id,
    surface: "execution-substrate",
    boundary: resolveScenario(id).description,
    backend: "docker",
    async run() {
      const detector = await runSandboxScenario({ scenarioId: id });
      return { verdict: detector.verdict, observed: detector.observed, evidence: { exitCode: detector.exitCode, teardownVerified: detector.teardownVerified } };
    },
  }])),
  // Product control-plane boundary, evaluated against the live Lab isolate.
  "lab-env-canary": {
    id: "lab-env-canary",
    surface: "lab-capability",
    boundary: HOSTILE_SCENARIOS["lab-env-canary"].description,
    backend: "lab",
    async run({ body, capabilities, baseUrl, authToken, policy, fetcher } = {}) {
      const receipt = await runHostileLabScenario({ scenarioId: "lab-env-canary", body, capabilities, baseUrl, authToken, policy: { ...DEFAULT_LAB_POLICY, ...policy }, fetcher });
      return { verdict: receipt.verifiedVerdict || receipt.verdict, observed: receipt.observed, evidence: { executionId: receipt.execution?.resultId || null, replayId: receipt.replay?.resultId || null }, receipt };
    },
  },
};

export const CAMPAIGN_SCENARIO_IDS = Object.keys(SCENARIO_SURFACES);

export function resolveCampaignScenario(scenarioId) {
  const scenario = SCENARIO_SURFACES[scenarioId];
  if (!scenario) throw new Error(`unknown campaign scenario: ${scenarioId} (expected one of: ${CAMPAIGN_SCENARIO_IDS.join(", ")})`);
  return scenario;
}

export function scenarioCatalog() {
  return CAMPAIGN_SCENARIO_IDS.map((id) => {
    const { surface, boundary, backend } = SCENARIO_SURFACES[id];
    return { id, surface, boundary, backend };
  });
}
