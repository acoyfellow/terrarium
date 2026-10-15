import { readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { client, writeReceipt } from "./lib.mjs";

const [subagentRunId, terrariumRunId, word] = process.argv.slice(2);

if (!subagentRunId || !terrariumRunId || !word) throw new Error("usage: 11-subagents.mjs <pi-subagents run id> <ter_ run id> <word>");

const api = client();
const status = (await api.call(`/api/runs/${terrariumRunId}/status`)).json;
const runDirs = [join(tmpdir(), `pi-subagents-uid-${process.getuid()}`, "async-subagent-runs", subagentRunId)];
const runDir = runDirs.find((dir) => existsSync(dir));
const local = runDir === undefined ? {} : JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
const localText = runDir === undefined ? "" : readdirSync(runDir).filter((name) => name.endsWith(".json") || name.endsWith(".log")).map((name) => readFileSync(join(runDir, name), "utf8")).join("\n");
const listed = (await api.call("/api/runs?channel=borrow-11&limit=50")).json;
const inChannel = JSON.stringify(listed).includes(terrariumRunId);
const badKey = await api.call("/api/runs", { method: "POST", headers: { "idempotency-key": "pi-subagents:x:0:sha" }, body: JSON.stringify({ task: "x" }) });

const results = [
  { name: "pi-subagents recorded a terrarium external-job run", ok: localText.includes("terrarium") && localText.includes(terrariumRunId), note: `${subagentRunId} state=${local.state ?? local.status ?? "?"}` },
  { name: "the Terrarium run finished done with this run's receipt", ok: status.terminal?.status === "done" && status.terminal?.provenance === "this-run", note: `${terrariumRunId} ${status.terminal?.status}/${status.terminal?.provenance}` },
  { name: "the agent's proof ran in the box and passed", ok: status.terminal?.proof?.exitCode === 0 && String(status.terminal?.proof?.command ?? "").includes(word), note: JSON.stringify(status.terminal?.proof ?? null).slice(0, 200) },
  { name: "the run carries the pi-subagents channel", ok: inChannel, note: "channel borrow-11 comes from the agent's runner.options" },
  { name: "the old colon idempotency key is still refused by the API (provider now sanitises it)", ok: badKey.status === 400, note: `status=${badKey.status}` },
];

writeReceipt(11, { title: "Terrarium as a pi-subagents external-job runner", subagentRunId, terrariumRunId, ok: results.every((result) => result.ok), results });
