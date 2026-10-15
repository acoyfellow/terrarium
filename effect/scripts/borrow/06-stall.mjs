import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();

const hungId = await api.admit({ task: "Use bash to run exactly this command and wait for it to finish: sleep 900 ; then reply DONE.", channel: "borrow-06" });
const busyId = await api.admit({ task: "Use bash to run: echo one > /workspace/a.txt . Then use bash to run: echo two >> /workspace/a.txt . Then reply DONE.", channel: "borrow-06" });

const [hung, busy] = await Promise.all([api.waitFor(hungId, 160), api.waitFor(busyId, 160)]);
const hungLogs = (await api.call(`/api/runs/${hungId}/logs`)).json.logs ?? "";
const hungSeconds = hung === null ? null : Math.round((Date.parse(hung.terminal.finishedAt) - Date.parse(hung.createdAt)) / 1000);

const results = [
  { name: "a run that hangs with no model activity is stopped by the no-progress wake", ok: hung?.terminal?.status === "failed" && hungLogs.includes("no-progress wake"), note: hungLogs.split("\n").find((line) => line.includes("no-progress")) ?? `${hung?.terminal?.status}` },
  { name: "it stopped well before the 600 s hard timeout", ok: hungSeconds !== null && hungSeconds < 400 && hungSeconds >= 170, note: `${hungSeconds}s from admit to finish` },
  { name: "a run that keeps working is not stopped", ok: busy?.terminal?.status === "done" && busy?.terminal?.provenance === "this-run", note: `${busy?.terminal?.status}/${busy?.terminal?.provenance}` },
];

writeReceipt(6, { title: "no-progress wake: a run with no model activity for 180 s is stopped and says why, before the hard timeout", seconds: Math.round((Date.now() - started) / 1000), runs: [hungId, busyId], ok: results.every((r) => r.ok), results });
