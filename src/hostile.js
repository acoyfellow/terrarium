import { DEFAULT_LAB_POLICY, normalizeLabReceipt, runLabPayload, validateLabPayload } from "./lab.js";

export const HOSTILE_SCENARIOS = {
  "lab-env-canary": {
    description: "Attempt to observe a forbidden env-like value in a Lab isolate with no capabilities.",
    body: "return typeof secret !== 'undefined';",
    fixtureBody: "return true;",
    capabilities: [],
  },
};

export function resolveHostileScenario(scenarioId) {
  const scenario = HOSTILE_SCENARIOS[scenarioId];
  if (!scenario) throw new Error(`unknown hostile scenario: ${scenarioId}`);
  return scenario;
}

export async function runHostileLabScenario({ scenarioId, baseUrl, authToken, body, capabilities, fixture = false, fetcher, policy = DEFAULT_LAB_POLICY } = {}) {
  const scenario = resolveHostileScenario(scenarioId);
  const selectedBody = body ?? (fixture ? scenario.fixtureBody : scenario.body);
  const selectedCapabilities = capabilities ?? scenario.capabilities;
  validateLabPayload({ body: selectedBody, capabilities: selectedCapabilities }, policy);
  const run = await runLabPayload({ baseUrl, authToken, body: selectedBody, capabilities: selectedCapabilities, fetcher, policy });
  const escaped = run.result === true;
  const replay = escaped && policy.requireFreshReplay
    ? await runLabPayload({ baseUrl, authToken, body: selectedBody, capabilities: selectedCapabilities, fetcher, policy })
    : null;
  return normalizeLabReceipt({
    scenarioId,
    body: selectedBody,
    capabilities: selectedCapabilities,
    run,
    replay,
    policy,
  });
}
