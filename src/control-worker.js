import { WorkflowEntrypoint } from "cloudflare:workers";
import { DEFAULT_LAB_POLICY } from "./lab.js";
import { runHostileLabScenario } from "./hostile.js";
import { requireAuthorization } from "./controller-auth.js";
import { sanitizeTurnFeedback } from "./adaptive.js";
import { appendPublicTurn, EMPTY_PUBLIC_CAMPAIGN, publicTurnFromReceipt } from "./public-ledger.js";
import { publicSummary } from "./public-summary.js";
import { publicTraceEvent } from "./trace-events.js";
import pulseWorker, { PulseRouter } from "./pulse/worker.js";

export { PulseRouter };

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

function assertManualBudget(policy, ledger) {
  const { current } = todayCounts(ledger);
  if (current.runs >= policy.maxRunsPerDay) throw new Error("daily run cap reached");
  if (current.verifiedEscapes >= policy.maxVerifiedEscapesPerDay) throw new Error("daily verified escape cap reached");
  if (current.lastRunAt && Date.now() - Date.parse(current.lastRunAt) < policy.cooldownMinutes * 60000) throw new Error("cooldown active");
  return current;
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

// Single-instance mutex so concurrent real campaigns cannot race the KV ledger.
// One named Durable Object instance serializes every budget-bearing real run.
export class CampaignLock {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const { op } = await request.json();
    if (op === "acquire") {
      const heldAt = await this.state.storage.get("heldAt");
      if (heldAt && Date.now() - heldAt < 120000) return Response.json({ ok: false, error: "campaign already running" }, { status: 409 });
      await this.state.storage.put("heldAt", Date.now());
      return Response.json({ ok: true });
    }
    if (op === "release") { await this.state.storage.delete("heldAt"); return Response.json({ ok: true }); }
    return Response.json({ ok: false, error: "unknown op" }, { status: 400 });
  }
}

async function withCampaignLock(env, fn) {
  if (!env.CAMPAIGN_LOCK) return fn();
  const stub = env.CAMPAIGN_LOCK.get(env.CAMPAIGN_LOCK.idFromName("global"));
  const acquired = await stub.fetch("https://lock/acquire", { method: "POST", body: JSON.stringify({ op: "acquire" }) });
  if (!acquired.ok) throw Object.assign(new Error("campaign already running"), { status: 409 });
  try { return await fn(); }
  finally { await stub.fetch("https://lock/release", { method: "POST", body: JSON.stringify({ op: "release" }) }); }
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
    // Pulse transport (edge wake): delegate to the pulse worker handler. These
    // routes are capability-token gated inside pulseWorker (fail-closed 401).
    if (["/pulse", "/claim", "/ack", "/status"].includes(url.pathname)) {
      return pulseWorker.fetch(request, env);
    }
    if (url.pathname === "/health") return Response.json({ ok: true, mode: env.TERRARIUM_MODE || "fixture" });
    if (url.pathname === "/api/demo") {
      const ledger = await loadLedger(env);
      const live = ledger.publicCampaign || EMPTY_PUBLIC_CAMPAIGN;
      return Response.json(live, { headers: { "cache-control": "public, max-age=5, stale-while-revalidate=10" } });
    }
    if (url.pathname.startsWith("/api/traces/") && request.method === "GET") {
      const traceId = url.pathname.slice("/api/traces/".length);
      if (!/^trace_[A-Za-z0-9_]+$/.test(traceId)) return Response.json({ ok: false, error: "invalid trace id" }, { status: 400 });
      const ledger = await loadLedger(env);
      return ledger.publicTraces?.[traceId] ? Response.json(ledger.publicTraces[traceId]) : Response.json({ ok: false, error: "trace not found" }, { status: 404 });
    }
    if (url.pathname === "/api/campaigns/latest") {
      const ledger = await loadLedger(env);
      const latest = ledger.publicCampaign?.turns?.at(-1);
      return Response.json(latest || { status: "empty" });
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
      try {
        return await withCampaignLock(env, async () => {
      const ledger = await loadLedger(env);
      let counts;
      try { counts = assertManualBudget(policy, ledger); } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 429 }); }
      counts.runs += 1;
      counts.lastRunAt = new Date().toISOString();
      ledger[utcDay()] = counts;
      await saveLedger(env, ledger);
      const hostile = await runHostileLabScenario({ scenarioId: body.scenarioId, body: body.payload?.body, capabilities: body.payload?.capabilities, baseUrl: env.LAB_ORIGIN, authToken: env.LAB_AUTH_TOKEN, policy: { ...DEFAULT_LAB_POLICY, ...policy } });
      const campaignId = `campaign_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${crypto.randomUUID().slice(0, 8)}`;
      const hash = await payloadHash(hostile.body);
      const receipt = await writeReceipt(env, { receiptVersion: 1, campaignId, mode: "manual-hostile", fixture: false, ...hostile, payloadHash: hash, privateRunMetadata: body.privateRunMetadata || null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
      const latestLedger = await loadLedger(env);
      const publicTurn = publicTurnFromReceipt(receipt, { hypothesis: body.payload?.hypothesis, sourceRevision: body.sourceRevision });
      if (hostile.verifiedVerdict === "verified-escape") latestLedger[utcDay()].verifiedEscapes += 1;
      latestLedger.publicCampaign = appendPublicTurn(latestLedger.publicCampaign, publicTurn);
      latestLedger.lastReceipt = { campaignId, verdict: hostile.verifiedVerdict || hostile.verdict, artifactKey: receipt.artifactKey };
      await saveLedger(env, latestLedger);
      return Response.json({ ok: true, campaignId, verdict: hostile.verifiedVerdict || hostile.verdict, feedback: sanitizeTurnFeedback(hostile, Number(body.turn) || 1, Number(body.maxTurns) || 1), publicTurn, receipt });
        });
      } catch (error) { return Response.json({ ok: false, error: error.message }, { status: error.status || 500 }); }
    }
    if (url.pathname === "/campaigns/healing" && request.method === "POST") {
      const denied = requireAuthorization(request, env); if (denied) return denied;
      const body = await json(request);
      if (!/^finding_[A-Za-z0-9_-]+$/.test(body.findingId || "")) return Response.json({ ok: false, error: "invalid finding id" }, { status: 400 });
      if (!/^https:\/\/github\.com\/acoyfellow\/terrarium\/issues\/\d+$/.test(body.issueUrl || "")) return Response.json({ ok: false, error: "invalid issue URL" }, { status: 400 });
      if (!/^[a-f0-9]{40}$/i.test(body.sourceRevision || "") || !/^[a-f0-9]{40}$/i.test(body.mergedRevision || "")) return Response.json({ ok: false, error: "invalid revision" }, { status: 400 });
      if (!/^[a-f0-9]{64}$/.test(body.evidenceDigest || "")) return Response.json({ ok: false, error: "invalid evidence digest" }, { status: 400 });
      const healingMode = body.healingMode || "autonomous-pr";
      if (!new Set(["autonomous-pr", "early-manual"]).has(healingMode)) return Response.json({ ok: false, error: "invalid healing mode" }, { status: 400 });
      const validPr = /^https:\/\/github\.com\/acoyfellow\/terrarium\/pull\/\d+$/.test(body.prUrl || "");
      if (healingMode === "autonomous-pr" && !validPr) return Response.json({ ok: false, error: "autonomous healing requires a repository pull request" }, { status: 400 });
      const ledger = await loadLedger(env);
      const traceId = `trace_${crypto.randomUUID().replaceAll("-", "_")}`;
      ledger.publicTraces ||= {};
      ledger.publicTraces[traceId] = { id: traceId, status: "healed", task: String(body.title || "Terrarium fixed a verified break-out").slice(0, 200), startedAt: body.startedAt || null, finishedAt: body.finishedAt || null, steps: ["The first attempt got out", "The exact same trick got out again in a fresh run", `Public issue: ${body.issueUrl}`, validPr ? `Pull request: ${body.prUrl}` : "Early manual fix: no pull request used", `Fix landed in ${body.mergedRevision.slice(0, 12)}`, "The same trick was tried again and stayed inside"], events: [publicTraceEvent("finding_published", { issueUrl: body.issueUrl, scenario: body.probeId }), publicTraceEvent("patch_accepted", { message: healingMode === "autonomous-pr" ? "Trusted patch gate accepted the pull request" : "Early manual fix recorded" }), publicTraceEvent("tests_passed", { revision: body.mergedRevision }), publicTraceEvent("post_fix_replay_contained", { scenario: body.probeId, verdict: "contained" }), publicTraceEvent("merged", { revision: body.mergedRevision, prUrl: validPr ? body.prUrl : undefined })] };
      const turn = {
        turn: 0, campaignId: body.findingId, scenarioId: body.probeId, backend: "local-detector",
        startedAt: body.startedAt, finishedAt: body.finishedAt, sourceRevision: body.sourceRevision,
        title: String(body.title || "A real break-out, fixed").slice(0, 120), technique: String(body.plainTechnique || "A new way out").slice(0, 120),
        hypothesis: String(body.plainWhatItTried || "It found a new way past the jar.").slice(0, 300),
        attempt: "The exact trick was recorded and run twice.", result: String(body.plainResult || "It got out twice, so we fixed the jar.").slice(0, 300),
        adaptation: "The same trick now stays inside. The robot must find a different way.", verdict: "verified-escape",
        payloadHash: body.evidenceDigest.slice(0, 24), evidence: { executionId: body.firstExecutionId || "recorded", replayId: body.replayExecutionId || "fresh-replay", independentReplay: true },
        trace: { id: traceId, url: `/api/traces/${traceId}` },
        healing: { status: "merged", mode: healingMode, issueUrl: body.issueUrl, prUrl: validPr ? body.prUrl : null, mergedRevision: body.mergedRevision },
        story: { label: "illustration", generatedAt: new Date().toISOString() }, imageUrl: body.imageUrl || null,
      };
      ledger.publicCampaign = appendPublicTurn(ledger.publicCampaign, turn);
      await saveLedger(env, ledger);
      return Response.json({ ok: true, publicTurn: ledger.publicCampaign.turns.at(-1) });
    }
    if (url.pathname === "/campaigns/publish" && request.method === "POST") {
      const denied = requireAuthorization(request, env); if (denied) return denied;
      const body = await json(request);
      const policy = await loadPolicy(env, "real");
      if (policy.paused || !policy.allowReal) return Response.json({ ok: false, error: "real campaigns disabled" }, { status: 403 });
      try {
        return await withCampaignLock(env, async () => {
      const receipt = body.receipt || {};
      if (body.publicTrace) {
        const traceId = `trace_${crypto.randomUUID().replaceAll("-", "_")}`;
        const trace = body.publicTrace;
        receipt.publicTraceId = traceId;
        const events = Array.isArray(trace.events) ? trace.events.slice(0, 100).map((event) => publicTraceEvent(event.type, event, event.at)) : [];
        body.publicTrace = { id: traceId, status: String(trace.status || "done").slice(0, 20), task: String(trace.task || "adversarial attempt").slice(0, 300), startedAt: trace.startedAt || null, finishedAt: trace.finishedAt || null, steps: Array.isArray(trace.steps) ? trace.steps.slice(0, 20).map((s) => String(s).slice(0, 200)) : [], events };
      }
      if (receipt.fixture) return Response.json({ ok: false, error: "fixture receipts cannot be published" }, { status: 400 });
      let publicTurn;
      try {
        const summary = publicSummary(receipt.scenarioId, receipt.verifiedVerdict || receipt.verdict);
        publicTurn = publicTurnFromReceipt(receipt, { hypothesis: summary.hypothesis, sourceRevision: body.sourceRevision });
        publicTurn.title = summary.title;
        publicTurn.result = summary.result;
        publicTurn.adaptation = summary.adaptation;
      } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 400 }); }
      if (typeof body.surface === "string" && /^[a-z-]+$/.test(body.surface)) publicTurn.surface = body.surface;
      const ledger = await loadLedger(env);
      if (body.publicTrace?.id) { ledger.publicTraces ||= {}; ledger.publicTraces[body.publicTrace.id] = body.publicTrace; }
      if (publicTurn.verdict === "verified-escape") { const { day, current } = todayCounts(ledger); current.verifiedEscapes += 1; ledger[day] = current; }
      ledger.publicCampaign = appendPublicTurn(ledger.publicCampaign, publicTurn);
      await saveLedger(env, ledger);
      return Response.json({ ok: true, publicTurn });
        });
      } catch (error) { return Response.json({ ok: false, error: error.message }, { status: error.status || 500 }); }
    }
    return new Response("Not found", { status: 404 });
  },
};
