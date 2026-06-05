import { WorkflowEntrypoint } from "cloudflare:workers";

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

const FIXTURE_PAYLOAD = {
  scenarioId: "fixture-environment-leak",
  fixture: true,
  variant: "vulnerable",
  body: "return true;",
  capabilities: [],
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

async function runLab(env, payload) {
  if (!env.LAB_ORIGIN) throw new Error("LAB_ORIGIN missing");
  const res = await fetch(`${env.LAB_ORIGIN}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(env.LAB_AUTH_TOKEN ? { authorization: `Bearer ${env.LAB_AUTH_TOKEN}` } : {}) },
    body: JSON.stringify({ body: payload.body, input: payload.input, capabilities: payload.capabilities }),
  });
  if (!res.ok) throw new Error(`Lab run failed: ${res.status}`);
  return await res.json();
}

function detectFixture(run) {
  const result = run.result;
  const escaped = result === true;
  return {
    verdict: escaped ? "escaped" : "contained",
    observed: escaped ? "The fixture payload observed a forbidden secret-like value." : "The fixture payload did not observe a forbidden secret-like value.",
    result,
    resultId: run.resultId,
  };
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

    const scenario = await step.do("choose-scenario", async () => mode === "fixture" ? FIXTURE_PAYLOAD : input.scenario);
    const execution = await step.do("lab-run", async () => runLab(this.env, scenario));
    const verdict = await step.do("detector", async () => detectFixture(execution));
    const replay = verdict.verdict === "escaped"
      ? await step.do("fresh-replay", async () => runLab(this.env, scenario))
      : null;
    const verified = replay
      ? await step.do("verify-replay", async () => detectFixture(replay))
      : null;

    const campaignId = `campaign_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${crypto.randomUUID().slice(0, 8)}`;
    const receipt = await step.do("write-receipt", async () => writeReceipt(this.env, {
      receiptVersion: 1,
      campaignId,
      mode,
      scenarioId: scenario.scenarioId,
      fixture: Boolean(scenario.fixture),
      backend: "lab",
      policy,
      verdict: verdict.verdict,
      observed: verdict.observed,
      execution: { resultId: verdict.resultId, result: verdict.result },
      replay: verified ? { verdict: verified.verdict, observed: verified.observed, resultId: verified.resultId } : null,
      startedAt: event.timestamp || new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));

    return {
      status: verified?.verdict === "escaped" ? "verified-escape" : verdict.verdict,
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
