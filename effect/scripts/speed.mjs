import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const receipt = join(here, "..", "receipts", "speed.json");
const url = process.env.TERRARIUM_EFFECT_URL ?? JSON.parse(readFileSync(join(homedir(), ".terrarium", "config.json"), "utf8")).cloudUrl;
const label = process.argv[2] ?? "baseline";
const count = Number(process.argv[3] ?? 5);
const token = execFileSync("cloudflared", ["access", "token", `-app=${url}`], { encoding: "utf8" }).trim();
const headers = { "cf-access-token": token, "content-type": "application/json" };

const get = async (path) => (await fetch(new URL(path, url), { headers })).json();

const phasesOf = (logs) => Object.fromEntries([...(logs.match(/TERRARIUM_PHASES (.*)/)?.[1] ?? "").matchAll(/(\w+)=(\d+)/g)].map(([, key, value]) => [key, Number(value)]));

const oneRun = async () => {
  const startedMs = Date.now();
  const admitted = await (await fetch(new URL("/api/runs", url), { method: "POST", headers: { ...headers, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ task: "Reply with the single word: ok", channel: `speed-${label}` }) })).json();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await get(`/api/runs/${admitted.runId}/status`);
    if (status.terminal !== null) {
      const logs = (await get(`/api/runs/${admitted.runId}/logs`)).logs;
      return { runId: admitted.runId, wallMs: Date.now() - startedMs, status: status.status, phases: phasesOf(logs) };
    }
  }
};

const runs = [];
for (let index = 0; index < count; index += 1) runs.push(await oneRun());

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const medianOf = (key) => median(runs.map((run) => run.phases[key]).filter(Number.isFinite));
const summary = { label, at: new Date().toISOString(), runs: runs.length, done: runs.filter((run) => run.status === "done").length, medianWallMs: median(runs.map((run) => run.wallMs)), medianPhases: { box_ms: medianOf("box_ms"), runner_wait_ms: medianOf("runner_wait_ms"), agent_ms: medianOf("agent_ms"), tail_ms: medianOf("tail_ms"), total_ms: medianOf("total_ms") }, samples: runs };

const previous = (() => {
  try {
    return JSON.parse(readFileSync(receipt, "utf8"));
  } catch {
    return { experiments: [] };
  }
})();
const experiments = [...previous.experiments.filter((experiment) => experiment.label !== label), summary];
writeFileSync(receipt, `${JSON.stringify({ baselineMs: 20000, experiments }, null, 2)}\n`);
console.log(JSON.stringify({ label, done: summary.done, medianWallMs: summary.medianWallMs, medianPhases: summary.medianPhases }));
