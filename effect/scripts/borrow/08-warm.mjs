import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();
const salt = crypto.randomUUID().slice(0, 8);
const repo = { github: "jonschlinkert/is-odd", ref: "master", setup: `npm install --no-package-lock --ignore-scripts && echo ${salt} > /dev/null` };
const task = "Use bash to run: ls node_modules | head -5 ; node -e \"console.log(require('./')(3))\" ; then reply with the last line it printed.";
const proof = "test -d node_modules/is-number && node -e \"process.exit(require('./')(3) === true ? 0 : 1)\"";

const timed = async (body) => {
  const t0 = Date.now();
  const runId = await api.admit(body);
  const run = await api.waitFor(runId, 200);
  const logs = (await api.call(`/api/runs/${runId}/logs`)).json.logs ?? "";

  return { runId, run, logs, seconds: Math.round((Date.now() - t0) / 1000) };
};

const cold = await timed({ task, channel: "borrow-08", repo, proof });
const warm = await timed({ task, channel: "borrow-08", repo, proof });
const sealed = await timed({ task: "Use bash to run: curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/is-number > /workspace/code.txt ; cat /workspace/code.txt ; then finish.", channel: "borrow-08", repo, proof: "test \"$(cat code.txt)\" != 200" });

const baseOf = (entry) => entry.run?.terminal?.repo?.base ?? null;
const coldBase = baseOf(cold);
const warmBase = baseOf(warm);

const results = [
  { name: "first run builds the base: checkout, setup with registry access, snapshot", ok: coldBase?.hit === false && coldBase?.setupExit === 0 && cold.logs.includes("warm base") && cold.run?.terminal?.proof?.exitCode === 0, note: `${cold.seconds}s setup=${coldBase?.setupMs}ms ${cold.logs.split("\n").find((l) => l.includes("[terrarium:setup]")) ?? ""}` },
  { name: "second run starts from the warm base with dependencies already installed", ok: warmBase?.hit === true && warmBase?.key === coldBase?.key && warm.run?.terminal?.proof?.exitCode === 0, note: `${warm.seconds}s ${warm.logs.split("\n").find((l) => l.includes("from warm base")) ?? ""}` },
  { name: "the warm start is faster than the cold build", ok: warm.seconds < cold.seconds, note: `cold ${cold.seconds}s vs warm ${warm.seconds}s` },
  { name: "the registry is closed again while the agent works", ok: sealed.run?.terminal?.proof?.exitCode === 0, note: `agent saw ${sealed.run?.terminal?.summary?.slice(0, 40) ?? "?"}` },
  { name: "the diff excludes installed dependencies", ok: !(warm.run?.terminal?.repo?.diff ?? "").includes("node_modules"), note: (warm.run?.terminal?.repo?.diff ?? "").split("\n")[0] ?? "" },
];

writeReceipt(8, { title: "warm repo bases: checkout plus setup is snapshotted once per owner/repo/ref/setup; later runs restore it", seconds: Math.round((Date.now() - started) / 1000), repo, runs: [cold.runId, warm.runId, sealed.runId], timings: { coldSeconds: cold.seconds, warmSeconds: warm.seconds }, ok: results.every((r) => r.ok), results });
