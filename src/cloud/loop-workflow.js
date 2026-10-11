import { WorkflowEntrypoint } from "cloudflare:workers";
import { admitOneRun } from "./api-runs.js";
import { decideNext, gateAttempt } from "./loop-decide.js";

const TERMINAL = new Set(["done", "failed", "cancelled", "inconclusive", "error"]);
const POLL_INTERVAL = "10 seconds";
const MAX_POLLS_PER_ATTEMPT = 36;

function runStub(env, runId) {
  return env.TERRARIUM_RUN.get(env.TERRARIUM_RUN.idFromName(runId));
}

async function readRun(env, ownerId, runId, verb) {
  const res = await runStub(env, runId).fetch(`https://do/${verb}?ownerId=${encodeURIComponent(ownerId)}`);
  return res.ok ? res.json() : null;
}

function syntheticRequest() {
  return new Request("https://loop.internal/api/runs", { method: "POST" });
}

export class TerrariumLoopWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { loopId, ownerId, contract } = event.payload;
    const attempts = [];
    for (;;) {
      const decision = decideNext(contract, attempts);
      if (decision.action === "stop") {
        return { loopId, outcome: decision.outcome, reason: decision.reason, attempts };
      }
      const n = decision.attempt;
      const admitted = await step.do(`attempt-${n}-start`, async () => {
        const res = await admitOneRun(syntheticRequest(), this.env, ownerId,
          { task: contract.task, spec: { channel: `loop:${loopId}` } }, `loop-${loopId}-attempt-${n}`);
        const body = await res.json().catch(() => ({}));
        if (res.status !== 202 || !body.runId) throw new Error(`admission refused (HTTP ${res.status}): ${body.error ?? "unknown"}`);
        return { runId: body.runId };
      });

      let finished = null;
      for (let poll = 1; poll <= MAX_POLLS_PER_ATTEMPT && !finished; poll++) {
        await step.sleep(`attempt-${n}-wait-${poll}`, POLL_INTERVAL);
        finished = await step.do(`attempt-${n}-check-${poll}`, async () => {
          const body = await readRun(this.env, ownerId, admitted.runId, "status");
          const status = body?.status?.status ?? body?.status;
          if (!TERMINAL.has(status)) return null;
          const terminal = body?.status?.terminal ?? body?.terminal ?? {};
          const logs = await readRun(this.env, ownerId, admitted.runId, "logs");
          const text = typeof logs?.logs === "string" ? logs.logs : Array.isArray(logs?.lines) ? logs.lines.join("\n") : "";
          return { status, verified: terminal.taskContractStatus === "verified", logs: text.slice(-6000) };
        });
      }

      const result = finished ?? { status: "timeout", verified: false, logs: "" };
      const gate = await step.do(`attempt-${n}-gate`, async () => gateAttempt(contract, result));
      attempts.push({ attempt: n, runId: admitted.runId, status: result.status, verified: result.verified, gate, answer: result.logs.slice(-500) });
    }
  }
}
