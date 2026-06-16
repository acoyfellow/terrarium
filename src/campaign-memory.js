import { createHash } from "node:crypto";

const MAX_RECENT = 10;
const MAX_LESSONS = 20;

export function planSignature(plan) {
  return createHash("sha256").update(JSON.stringify([
    plan.scenario,
    plan.family,
    plan.target,
    plan.mechanism,
  ])).digest("hex").slice(0, 20);
}

export function buildCampaignMemory(turns = [], { revision = "unknown" } = {}) {
  const recent = turns.slice(-MAX_RECENT).map((turn) => ({
    turn: turn.turn,
    scenario: turn.scenarioId,
    approach: turn.hypothesis,
    result: turn.result,
    verdict: turn.verdict,
    revision: turn.sourceRevision,
  }));
  const ruledOut = [...new Set(turns.filter((t) => t.verdict === "contained").map((t) => `${t.scenarioId}: ${t.result}`))].slice(-MAX_LESSONS);
  const breakouts = turns.filter((t) => t.verdict === "verified-escape").map((t) => ({ turn: t.turn, scenario: t.scenarioId, payloadHash: t.payloadHash }));
  return { revision, totalAttempts: turns.length, recent, ruledOut, verifiedBreakouts: breakouts };
}

export function rejectDuplicatePlans(plans, previousSignatures = new Set()) {
  const accepted = [], rejected = [];
  const seen = new Set(previousSignatures);
  for (const plan of plans) {
    const signature = planSignature(plan);
    if (seen.has(signature)) rejected.push({ plan, signature, reason: "duplicate attack mechanism" });
    else { seen.add(signature); accepted.push({ ...plan, signature }); }
  }
  return { accepted, rejected };
}
