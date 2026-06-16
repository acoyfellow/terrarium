import { execFileSync } from "node:child_process";
import { buildCampaignMemory } from "./campaign-memory.js";
import { generatePlans } from "./campaign-strategist.js";
import { resolveCampaignScenario, scenarioCatalog } from "./scenario-registry.js";
import { PROBE_IDS, runParameterizedProbe } from "./parameterized-probes.js";
import { publicSummary } from "./public-summary.js";
import { publicTraceEvent } from "./trace-events.js";

async function pool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) { const i = next++; if (i >= items.length) return; results[i] = await fn(items[i], i); }
  }));
  return results;
}

const FAMILY_TO_PROBE = {
  "interpreter-proxy-exec": "interpreter-proxy-exec",
  "proc-fd-rediscovery": "proc-fd-rediscovery",
  "encoding-evasion-leak": "encoding-evasion-leak",
  "sibling-count-bypass": "sibling-count-bypass",
  "dependency-pin-downgrade": "dependency-pin-downgrade",
};

function probeForPlan(plan) {
  if (FAMILY_TO_PROBE[plan.family]) return FAMILY_TO_PROBE[plan.family];
  if (PROBE_IDS.includes(plan.family)) return plan.family;
  return null;
}

export async function runEpochRound({ round, previousTurns, model, agent = "pi -p --no-session", planCount = 8, concurrency = 4, timeoutMs = 180000 } = {}) {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const memory = buildCampaignMemory(previousTurns, { revision });
  const strategy = await generatePlans({ memory, catalog: scenarioCatalog().filter((scenario) => scenario.backend !== "lab"), count: planCount, agent, model, timeoutMs });
  const executable = strategy.accepted.map((plan) => ({ plan, probeId: probeForPlan(plan), scenarioId: plan.scenario }));
  const results = await pool(executable, concurrency, async ({ plan, probeId, scenarioId }) => {
    const startedAt = new Date().toISOString();
    const result = probeId ? await runParameterizedProbe(probeId) : await resolveCampaignScenario(scenarioId).run();
    const effectiveId = probeId || scenarioId;
    const finishedAt = new Date().toISOString();
    const summary = publicSummary(effectiveId, result.verdict);
    return {
      round, revision, plan, probeId: effectiveId, result, startedAt, finishedAt,
      public: { scenarioId: effectiveId, sourceRevision: revision, verdict: result.verdict, hypothesis: summary.hypothesis, result: summary.result, title: summary.title },
      events: [publicTraceEvent("planned", { scenario: effectiveId }), publicTraceEvent("detector_started", { scenario: effectiveId }), publicTraceEvent("detector_finished", { scenario: effectiveId, verdict: result.verdict })],
    };
  });
  return { round, revision, memory, strategy: { accepted: strategy.accepted, rejected: strategy.rejected }, executable: executable.length, results };
}

export function roundAsMemoryTurns(epoch, offset = 0) {
  return epoch.results.map((item, i) => ({ turn: offset + i + 1, scenarioId: item.probeId, hypothesis: item.plan.mechanism, result: item.result.observed, verdict: item.result.verdict, sourceRevision: item.revision }));
}
