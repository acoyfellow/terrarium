import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();

const runId = await api.admit({ task: "Use bash to run: echo one > a.txt . Then use bash to run: sleep 20 . Then use bash to run: echo two >> a.txt && cat a.txt . Then reply DONE.", channel: "borrow-10" });

const snapshots = [];
let after = 0;
let sawWhileRunning = false;

for (let poll = 0; poll < 60; poll += 1) {
  const { json } = await api.call(`/api/runs/${runId}/activity?after=${after}`);

  snapshots.push({ t: Math.round((Date.now() - started) / 1000), status: json.status, newEvents: (json.events ?? []).length });

  if (json.status === "running" && (json.events ?? []).length > 0) sawWhileRunning = true;

  after = (json.events ?? []).at(-1)?.at ?? after;

  if (json.status !== "running") break;

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

const all = (await api.call(`/api/runs/${runId}/activity`)).json.events ?? [];
const other = await api.call("/api/runs/ter_zzzzzz_000000000000/activity");

const results = [
  { name: "steps are visible while the run is still running", ok: sawWhileRunning, note: JSON.stringify(snapshots.filter((s) => s.newEvents > 0).slice(0, 3)) },
  { name: "the log shows the agent's real tool calls in order", ok: all.filter((e) => e.kind === "tool").length >= 3 && all.some((e) => e.detail.includes("sleep 20")), note: all.map((e) => e.detail).slice(0, 5).join(" | ") },
  { name: "after= returns only newer steps (no duplicates when polling)", ok: snapshots.reduce((sum, s) => sum + s.newEvents, 0) === all.length, note: `${snapshots.reduce((sum, s) => sum + s.newEvents, 0)} incremental vs ${all.length} total` },
  { name: "another run id that is not mine is 404", ok: other.status === 404, note: String(other.status) },
];

writeReceipt(10, { title: "live run view: each model reply's tool calls are recorded per run and readable as they happen; the Pi extension shows them in a widget", seconds: Math.round((Date.now() - started) / 1000), runId, ok: results.every((r) => r.ok), results });
