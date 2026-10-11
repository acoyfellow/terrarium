#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] ?? process.env.TERRARIUM_EFFECT_URL;

if (!base) {
  console.error("pass the deployed URL as an argument or TERRARIUM_EFFECT_URL");
  process.exit(2);
}
const loginApp = process.env.TERRARIUM_LOGIN_APP ?? base;
const secrets = join(homedir(), ".terrarium", "secrets");
const checks = [];

const record = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

const accessToken = () => {
  try {
    return execFileSync("cloudflared", ["access", "token", `-app=${loginApp}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const read = (name) => readFileSync(join(secrets, name), "utf8").trim();

const service = () => {
  try {
    return { "cf-access-client-id": read("terrarium-access-client-id.secret"), "cf-access-client-secret": read("terrarium-access-client-secret.secret") };
  } catch {
    return {};
  }
};

const call = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, { redirect: "manual", ...init });
  const text = await res.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }

  return { status: res.status, body };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const token = accessToken();
const me = token ? { "cf-access-token": token } : {};
const json = { "content-type": "application/json" };

const health = await call("/health", { headers: service() });
record("health answers", [200].includes(health.status), { status: health.status });

const anon = await call("/api/runs", { headers: service() });
record("no identity is refused", anon.status === 401, { status: anon.status });

const who = await call("/api/whoami", { headers: me });
record("access login identifies me", who.status === 200 && String(who.body.owner ?? who.body.id ?? "").startsWith("user:"), { status: who.status, owner: who.body.owner ?? who.body.id });

const key = `prod-check-${Date.now()}`;
const admitted = await call("/api/runs", { method: "POST", headers: { ...me, ...json, "idempotency-key": key }, body: JSON.stringify({ task: "What is 17 multiplied by 23? Reply with just the number." }) });
record("run admitted", admitted.status === 202 && Boolean(admitted.body.runId), { status: admitted.status, runId: admitted.body.runId, error: admitted.body.error });

const again = await call("/api/runs", { method: "POST", headers: { ...me, ...json, "idempotency-key": key }, body: JSON.stringify({ task: "What is 17 multiplied by 23? Reply with just the number." }) });
record("same key returns same run", again.body.runId === admitted.body.runId, { first: admitted.body.runId, second: again.body.runId });

let finalStatus = null;

for (let i = 0; i < 60 && admitted.body.runId; i++) {
  await sleep(5000);
  const s = await call(`/api/runs/${admitted.body.runId}/status`, { headers: me });

  if (s.body.status && s.body.status !== "running") {
    finalStatus = s.body;
    break;
  }
}

record("run finishes done and verified", finalStatus?.status === "done" && finalStatus?.terminal?.contractStatus === "verified", { status: finalStatus?.status, contractStatus: finalStatus?.terminal?.contractStatus, summary: finalStatus?.terminal?.summary });

const bobToken = JSON.parse(read("ax-principals.json")).find((p) => p.id === "ax-bob")?.token;
const bob = { ...service(), authorization: `Bearer ${bobToken}` };
const bobRead = await call(`/api/runs/${admitted.body.runId}/status`, { headers: bob });
record("another person cannot read my run", bobRead.status === 404, { status: bobRead.status });

const startLoop = async (expect) => call("/api/loops", { method: "POST", headers: { ...me, ...json }, body: JSON.stringify({ goal: `prod check ${expect}`, task: "What is 17 multiplied by 23? Reply with just the number.", expect, maxAttempts: 2 }) });

const waitLoop = async (loopId) => {
  for (let i = 0; i < 90; i++) {
    await sleep(6000);
    const l = await call(`/api/loops/${loopId}`, { headers: me });
    const status = l.body.status;

    if (["complete", "errored", "terminated"].includes(status)) return l.body;
  }

  return null;
};

const outcomeOf = (loop) => loop?.output?.decision?.outcome;

const passing = await startLoop("391");
const passed = passing.body.loopId ? await waitLoop(passing.body.loopId) : null;
record("loop that should pass passes", outcomeOf(passed) === "passed", { loopId: passing.body.loopId, status: passing.status, outcome: outcomeOf(passed) });

const failing = await startLoop("kumquat-never");
const exhausted = failing.body.loopId ? await waitLoop(failing.body.loopId) : null;
record("loop that cannot pass gives up", outcomeOf(exhausted) === "exhausted", { loopId: failing.body.loopId, outcome: outcomeOf(exhausted) });

const bobLoop = await call(`/api/loops/${passing.body.loopId}`, { headers: bob });
record("another person cannot read my loop", bobLoop.status === 404, { status: bobLoop.status });

const badLoop = await call("/api/loops", { method: "POST", headers: { ...me, ...json }, body: JSON.stringify({ goal: "x", task: "y" }) });
record("a loop without an expected answer is refused", badLoop.status === 400, { status: badLoop.status });

const ok = checks.every((c) => c.pass);
writeFileSync(join(root, "receipts", "prod-checks.json"), `${JSON.stringify({ base: "<deployed effect worker>", at: new Date().toISOString(), ok, checks }, null, 2)}\n`);
console.log(ok ? "ALL PROD CHECKS PASS" : "SOME PROD CHECKS FAIL");
process.exit(ok ? 0 : 1);
