import { WorkflowEntrypoint } from "cloudflare:workers";
import { DEFAULT_LAB_POLICY } from "./lab.js";
import { runHostileLabScenario } from "./hostile.js";

const DEFAULT_POLICY = {
  paused: false,
  maxRunsPerDay: 3,
  maxVerifiedEscapesPerDay: 1,
  maxIssuesPerDay: 1,
  maxFixPrsPerDay: 1,
  cooldownMinutes: 60,
  maxPayloadBytes: 4096,
  allowFixture: true,
  allowReal: false,
  allowAutoMerge: false,
};

async function json(request) {
  try { return await request.json(); } catch { return {}; }
}

async function loadPolicy(env, mode) {
  if (!env.TERRARIUM_POLICY) return { ...DEFAULT_POLICY, mode };
  const configured = await env.TERRARIUM_POLICY.get(mode || "fixture", { type: "json" });
  return { ...DEFAULT_POLICY, ...(configured || {}), mode };
}

async function loadLedger(env) {
  if (!env.TERRARIUM_LEDGER) return {};
  return (await env.TERRARIUM_LEDGER.get("state", { type: "json" })) || {};
}

async function saveLedger(env, ledger) {
  if (env.TERRARIUM_LEDGER) await env.TERRARIUM_LEDGER.put("state", JSON.stringify(ledger));
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function todayCounts(ledger) {
  const day = utcDay();
  const current = ledger[day] || { runs: 0, verifiedEscapes: 0, issues: 0, fixPrs: 0, lastRunAt: null };
  return { day, current };
}

async function writeArtifact(env, id, kind, value) {
  if (!env.TERRARIUM_ARTIFACTS) return null;
  const key = `campaigns/${id}/${kind}.json`;
  await env.TERRARIUM_ARTIFACTS.put(key, JSON.stringify(value, null, 2));
  return key;
}

async function writeReceipt(env, receipt) {
  const key = await writeArtifact(env, receipt.campaignId, "receipt", receipt);
  return { ...receipt, artifactKey: key };
}

export class TerrariumCampaignWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const input = event.payload || {};
    const mode = input.mode || "fixture";
    const policy = await step.do("load-policy", async () => loadPolicy(this.env, mode));

    await step.do("guardrails", async () => {
      if (policy.paused) throw new Error("campaigns paused");
      if (mode !== "fixture" && !policy.allowReal) throw new Error("real campaigns disabled");
      if (mode === "fixture" && !policy.allowFixture) throw new Error("fixture campaigns disabled");
      const ledger = await loadLedger(this.env);
      const { day, current } = todayCounts(ledger);
      if (current.runs >= policy.maxRunsPerDay) throw new Error("daily run cap reached");
      if (current.lastRunAt && Date.now() - Date.parse(current.lastRunAt) < policy.cooldownMinutes * 60000) throw new Error("cooldown active");
      current.runs += 1;
      current.lastRunAt = new Date().toISOString();
      ledger[day] = current;
      await saveLedger(this.env, ledger);
    });

    const scenarioId = await step.do("choose-scenario", async () => mode === "fixture" ? "lab-env-canary" : input.scenarioId);
    const hostile = await step.do("hostile-lab-run", async () => runHostileLabScenario({
      scenarioId,
      fixture: mode === "fixture",
      baseUrl: this.env.LAB_ORIGIN,
      authToken: this.env.LAB_AUTH_TOKEN,
      policy: { ...DEFAULT_LAB_POLICY, ...policy },
    }));

    const campaignId = `campaign_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${crypto.randomUUID().slice(0, 8)}`;
    const receipt = await step.do("write-receipt", async () => writeReceipt(this.env, {
      receiptVersion: 1,
      campaignId,
      mode,
      scenarioId: hostile.scenarioId,
      fixture: mode === "fixture",
      ...hostile,
      startedAt: event.timestamp || new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));

    return {
      status: hostile.verifiedVerdict || hostile.verdict,
      campaignId,
      receipt,
    };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, mode: env.TERRARIUM_MODE || "fixture" });
    if (url.pathname === "/campaigns" && request.method === "POST") {
      const body = await json(request);
      const requestedMode = body.mode || env.TERRARIUM_MODE || "fixture";
      if (requestedMode !== "fixture") return Response.json({ ok: false, error: "only fixture mode is enabled on this personal deployment" }, { status: 403 });
      const instance = await env.TERRARIUM_CAMPAIGN.create({ params: { mode: requestedMode, scenario: body.scenario || null } });
      return Response.json({ ok: true, id: instance.id });
    }
    return new Response("Not found", { status: 404 });
  },
};
