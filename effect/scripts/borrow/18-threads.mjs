import { execFileSync } from "node:child_process";

import { client, writeReceipt } from "./lib.mjs";

const [runId, word] = process.argv.slice(2);

if (!runId || !word) throw new Error("usage: 18-threads.mjs <ter_ run started from the Threads composer> <word>");

const api = client();
const token = execFileSync("cloudflared", ["access", "token", `-app=${api.url}`], { encoding: "utf8" }).trim();
const page = await fetch(new URL("/threads", api.url), { headers: { "cf-access-token": token } });
const html = await page.text();
const bundle = html.match(new RegExp("assets/index-[A-Za-z0-9_-]+\\.js"))?.[0] ?? "";
const script = bundle === "" ? "" : await (await fetch(new URL(`/${bundle}`, api.url), { headers: { "cf-access-token": token } })).text();
const listed = (await api.call("/api/runs?channel=borrow-11&limit=20")).json.runs ?? [];
const run = listed.find((one) => one.runId === runId);
const events = (await api.call(`/api/runs/${runId}/activity`)).json.events ?? [];

const results = [
  { name: "prod serves the /threads page with the Threads view in its bundle", ok: page.status === 200 && script.includes("Run threads") && script.includes("New run in"), note: `status=${page.status} bundle=${bundle}` },
  { name: "the run list carries task and proof for the thread view", ok: run?.task?.includes(word) === true && run?.proof === `grep -qx ${word} t.txt`, note: JSON.stringify({ task: run?.task?.slice(0, 80), proof: run?.proof }) },
  { name: "the run started from the composer joined the selected thread's channel", ok: run?.channel === "borrow-11", note: `channel=${run?.channel}` },
  { name: "its tool steps were recorded for the thread view", ok: events.some((event) => event.kind === "tool" && event.detail.includes(word)), note: JSON.stringify(events.map((event) => event.detail)).slice(0, 200) },
  { name: "it finished done with this run's receipt and proof exit 0", ok: run?.terminal?.status === "done" && run?.terminal?.provenance === "this-run" && run?.terminal?.proof?.exitCode === 0, note: `${runId} ${run?.terminal?.status}/${run?.terminal?.provenance}` },
];

writeReceipt(18, { title: "thread UI over runs: /threads groups runs by channel as conversations (task, tool steps, receipt) with a composer", runId, screenshot: "receipts/borrow/18-threads.png", ok: results.every((result) => result.ok), results });
