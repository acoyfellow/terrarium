import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { client, writeReceipt } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const effectDir = join(here, "..", "..");
const config = process.env.TERRARIUM_WRANGLER_CONFIG ?? "wrangler.ax.local.jsonc";
const workflow = process.env.TERRARIUM_RUN_WORKFLOW ?? "terrarium-effect-run";

const api = client();
const started = Date.now();

const runId = await api.admit({ task: "Use bash to run: date +%s%N > /workspace/stamp.txt && cat /workspace/stamp.txt ; then reply with the number it printed.", channel: "borrow-03" });
const first = await api.waitFor(runId);

const restart = (() => {
  try {
    return { ok: true, output: execFileSync("npx", ["wrangler", "workflows", "instances", "restart", workflow, runId, "-c", config], { cwd: effectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    return { ok: false, output: String(error.stderr ?? error.message).slice(-400) };
  }
})();

const describe = () => {
  try {
    return JSON.parse(execFileSync("npx", ["wrangler", "workflows", "instances", "describe", workflow, runId, "-c", config, "--json"], { cwd: effectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return null;
  }
};

const replay = await (async () => {
  for (let poll = 0; poll < 60; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const info = describe();
    const status = info?.status ?? info?.instance?.status ?? "";

    if (["complete", "completed", "errored", "terminated"].includes(String(status).toLowerCase())) return info;
  }

  return describe();
})();

const record = (await api.call(`/api/runs/${runId}/status`)).json;
const replayText = JSON.stringify(replay ?? {});

const results = [
  { name: "the first execution finished with a receipt from this run", ok: first?.terminal?.provenance === "this-run", note: `${first?.terminal?.status}/${first?.terminal?.provenance}` },
  { name: "Workflows restarted the finished run instance (a real replay of the run step)", ok: restart.ok, note: restart.output.split("\n").slice(-1)[0] },
  { name: "the replayed step was refused instead of starting the agent again", ok: replayText.includes("start attempt 2 was refused"), note: replayText.includes("refused") ? "refusal recorded in the step output" : replayText.slice(0, 200) },
  { name: "the owner store counted two start attempts", ok: record.startAttempts === 2, note: `startAttempts=${record.startAttempts}` },
  { name: "the first terminal result was kept, not overwritten by the replay", ok: record.terminal?.provenance === "this-run" && record.terminal?.finishedAt === first?.terminal?.finishedAt, note: `${record.terminal?.status}/${record.terminal?.provenance} ${record.terminal?.finishedAt}` },
];

writeReceipt(3, { title: "never runs twice: a replayed run step is refused by an at-most-once start lease", seconds: Math.round((Date.now() - started) / 1000), runId, ok: results.every((r) => r.ok), results });
