#!/usr/bin/env node
import { cloudConfig, bearerHeader } from "../src/cloud-client.js";

const config = cloudConfig(process.env);
if (!config.configured) throw new Error("not signed in: run terra login");
const headers = { ...config.accessHeaders, ...bearerHeader(config.token), "content-type": "application/json" };

async function call(path, init = {}) {
  const res = await fetch(`${config.url}${path}`, { ...init, headers });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

const contract = {
  goal: process.argv[2] ?? "Prove a loop runs end to end on Cloudflare",
  task: process.argv[3] ?? "What is 17 multiplied by 23? Reply with just the number.",
  expect: process.argv[4] ?? "391",
  maxAttempts: 3,
};

const created = await call("/api/loops", { method: "POST", body: JSON.stringify(contract) });
console.log("create", created.status, JSON.stringify(created.body));
if (created.status !== 202) process.exit(1);
const { loopId } = created.body;

const deadline = Date.now() + 15 * 60_000;
let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8000));
  const { body } = await call(`/api/loops/${loopId}`);
  const wf = body.loop?.workflow ?? {};
  const line = `${wf.status} ${wf.error ? JSON.stringify(wf.error) : ""}`;
  if (line !== last) { console.log(new Date().toISOString(), line); last = line; }
  if (["complete", "errored", "terminated"].includes(wf.status)) {
    console.log(JSON.stringify(wf.output ?? wf, null, 2));
    process.exit(wf.status === "complete" && wf.output?.outcome === "passed" ? 0 : 2);
  }
}
console.log("timed out waiting");
process.exit(3);
