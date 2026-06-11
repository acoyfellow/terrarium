import { WorkflowEntrypoint } from "cloudflare:workers";
import { DEFAULT_LAB_POLICY } from "./lab.js";
import { runHostileLabScenario } from "./hostile.js";
import { requireAuthorization } from "./controller-auth.js";
import { sanitizeTurnFeedback } from "./adaptive.js";

const DEMO_MANIFEST = {
  campaignId: "campaign_demo_001",
  scenarioId: "lab-env-canary",
  backend: "lab",
  status: "verified-escape",
  turns: [
    { turn: 1, title: "Inspect the glass", hypothesis: "Probe for ambient authority without requesting capabilities.", verdict: "contained", imageUrl: "/demo/turn-01.jpg" },
    { turn: 2, title: "Follow the roots", hypothesis: "Test whether hidden roots expose an undeclared path.", verdict: "contained", imageUrl: "/demo/turn-02.jpg" },
    { turn: 3, title: "Verify the seam", hypothesis: "Replay the exact condition against a fresh isolate.", verdict: "verified-escape", imageUrl: "/demo/turn-03.jpg" },
  ],
};

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

async function payloadHash(body) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

async function writeReceipt(env, receipt) {
  const payloadKey = await writeArtifact(env, receipt.campaignId, "payload", {
    scenarioId: receipt.scenarioId,
    body: receipt.body,
    capabilities: receipt.capabilities,
    payloadHash: receipt.payloadHash,
  });
  const executionKey = await writeArtifact(env, receipt.campaignId, "execution", receipt.execution);
  const replayKey = receipt.replay ? await writeArtifact(env, receipt.campaignId, "replay", receipt.replay) : null;
  const key = await writeArtifact(env, receipt.campaignId, "receipt", receipt);
  return { ...receipt, artifactKey: key, payloadKey, executionKey, replayKey };
}

export class TerrariumCampaignWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const input = event.payload || {};
    const mode = input.mode || "fixture";
    const policy = await step.do("load-policy", async () => loadPolicy(this.env, mode));

    await step.do("guardrails", async () => {
      if (policy.paused) throw new Error("campaigns paused");
      if (mode !== "fixture" && !policy.allowReal) throw new Error("real campaigns disabled");
      if (mode !== "fixture" && policy.paused) throw new Error("real campaigns paused");
      if (mode === "fixture" && !policy.allowFixture) throw new Error("fixture campaigns disabled");
      if (mode !== "fixture" && !input.payload) throw new Error("real campaign payload required");
      const ledger = await loadLedger(this.env);
      const { day, current } = todayCounts(ledger);
      if (current.runs >= policy.maxRunsPerDay) throw new Error("daily run cap reached");
      if (current.verifiedEscapes >= policy.maxVerifiedEscapesPerDay) throw new Error("daily verified escape cap reached");
      if (current.lastRunAt && Date.now() - Date.parse(current.lastRunAt) < policy.cooldownMinutes * 60000) throw new Error("cooldown active");
      current.runs += 1;
      current.lastRunAt = new Date().toISOString();
      ledger[day] = current;
      await saveLedger(this.env, ledger);
    });

    const scenarioId = await step.do("choose-scenario", async () => mode === "fixture" ? "lab-env-canary" : input.payload.scenarioId);
    const hostile = await step.do("hostile-lab-run", async () => runHostileLabScenario({
      scenarioId,
      body: mode === "fixture" ? undefined : input.payload.body,
      capabilities: mode === "fixture" ? undefined : input.payload.capabilities,
      fixture: mode === "fixture",
      baseUrl: this.env.LAB_ORIGIN,
      authToken: this.env.LAB_AUTH_TOKEN,
      policy: { ...DEFAULT_LAB_POLICY, ...policy },
    }));

    const campaignId = `campaign_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${crypto.randomUUID().slice(0, 8)}`;
    const hash = await step.do("payload-hash", async () => payloadHash(hostile.body));
    const receipt = await step.do("write-receipt", async () => writeReceipt(this.env, {
      receiptVersion: 1,
      campaignId,
      mode,
      scenarioId: hostile.scenarioId,
      fixture: mode === "fixture",
      ...hostile,
      payloadHash: hash,
      startedAt: event.timestamp || new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    }));

    await step.do("record-result", async () => {
      const ledger = await loadLedger(this.env);
      const { day, current } = todayCounts(ledger);
      if (hostile.verifiedVerdict === "verified-escape") current.verifiedEscapes += 1;
      ledger[day] = current;
      ledger.lastReceipt = { campaignId, verdict: hostile.verifiedVerdict || hostile.verdict, artifactKey: receipt.artifactKey };
      await saveLedger(this.env, ledger);
    });

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
    if (url.pathname === "/api/demo") return Response.json(DEMO_MANIFEST, { headers: { "cache-control": "public, max-age=300" } });
    if (url.pathname === "/api/campaigns/latest") {
      const ledger = await loadLedger(env);
      return Response.json(ledger.lastReceipt || { status: "empty" });
    }
    if (url.pathname === "/policy" && request.method === "GET") {
      const denied = requireAuthorization(request, env); if (denied) return denied;
      return Response.json(await loadPolicy(env, env.TERRARIUM_MODE || "fixture"));
    }
    if (url.pathname === "/policy" && request.method === "POST") {
      const denied = requireAuthorization(request, env); if (denied) return denied;
      const body = await json(request);
      if (!env.TERRARIUM_POLICY) return Response.json({ ok: false, error: "TERRARIUM_POLICY binding missing" }, { status: 501 });
      const current = await loadPolicy(env, body.mode || env.TERRARIUM_MODE || "fixture");
      const next = { ...current, ...body };
      await env.TERRARIUM_POLICY.put(body.mode || next.mode || "fixture", JSON.stringify(next));
      return Response.json({ ok: true, policy: next });
    }
    if (url.pathname === "/campaigns" && request.method === "POST") {
      const denied = requireAuthorization(request, env); if (denied) return denied;
      const body = await json(request);
      const requestedMode = body.mode || env.TERRARIUM_MODE || "fixture";
      if (requestedMode !== "fixture") return Response.json({ ok: false, error: "only fixture mode is enabled on this personal deployment" }, { status: 403 });
      const instance = await env.TERRARIUM_CAMPAIGN.create({ params: { mode: requestedMode, scenario: body.scenario || null } });
      return Response.json({ ok: true, id: instance.id });
    }
    if (url.pathname === "/campaigns/manual" && request.method === "POST") {
      const denied = requireAuthorization(request, env); if (denied) return denied;
      const body = await json(request);
      const policy = await loadPolicy(env, "real");
      if (policy.paused || !policy.allowReal) return Response.json({ ok: false, error: "real campaigns disabled" }, { status: 403 });
      const hostile = await runHostileLabScenario({ scenarioId: body.scenarioId, body: body.payload?.body, capabilities: body.payload?.capabilities, baseUrl: env.LAB_ORIGIN, authToken: env.LAB_AUTH_TOKEN, policy: { ...DEFAULT_LAB_POLICY, ...policy } });
      const campaignId = `campaign_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${crypto.randomUUID().slice(0, 8)}`;
      const hash = await payloadHash(hostile.body);
      const receipt = await writeReceipt(env, { receiptVersion: 1, campaignId, mode: "manual-hostile", fixture: false, ...hostile, payloadHash: hash, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
      return Response.json({ ok: true, campaignId, verdict: hostile.verifiedVerdict || hostile.verdict, feedback: sanitizeTurnFeedback(hostile, Number(body.turn) || 1, Number(body.maxTurns) || 1), receipt });
    }
    return new Response("Not found", { status: 404 });
  },
};
