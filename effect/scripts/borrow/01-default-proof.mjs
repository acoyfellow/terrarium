import { client, writeReceipt } from "./lib.mjs";

const project = "printf '{\"scripts\":{\"test\":\"node --test\"}}' > package.json && printf \"const t=require('node:test');const a=require('node:assert');const {add}=require('./add.js');t('adds',()=>a.equal(add(2,3),5));\" > add.test.js";

const cases = [
  {
    name: "no proof given, broken project: detected tests run and the run fails",
    task: `Use bash to run exactly this, then finish: ${project} && printf 'module.exports={add:(a,b)=>a-b}' > add.js`,
    want: (t) => t.status === "failed" && t.proof?.source === "detected" && t.proof?.exitCode !== 0 && t.proof?.command === "npm test --silent",
  },
  {
    name: "no proof given, working project: detected tests run and the run is done",
    task: `Use bash to run exactly this, then finish: ${project} && printf 'module.exports={add:(a,b)=>a+b}' > add.js`,
    want: (t) => t.status === "done" && t.proof?.source === "detected" && t.proof?.exitCode === 0,
  },
  {
    name: "no proof given, no project: receipt-only behaviour is kept",
    task: "What is 17 times 23? Reply with just the number.",
    want: (t) => t.status === "done" && (t.proof === null || t.proof === undefined),
  },
  {
    name: "a given proof wins over detection",
    task: `Use bash to run exactly this, then finish: ${project} && printf 'module.exports={add:(a,b)=>a-b}' > add.js`,
    proof: "true",
    want: (t) => t.status === "done" && t.proof?.source === "given" && t.proof?.command === "true",
  },
];

const api = client();
const started = Date.now();
const runIds = await Promise.all(cases.map((entry) => api.admit({ task: entry.task, channel: "borrow-01", ...(entry.proof === undefined ? {} : { proof: entry.proof }) })));
const finals = await Promise.all(runIds.map((runId) => api.waitFor(runId)));

const results = cases.map((entry, index) => {
  const terminal = finals[index]?.terminal ?? null;

  return { name: entry.name, runId: runIds[index], ok: terminal !== null && entry.want(terminal), note: `${terminal?.status}/${terminal?.provenance} proof=${terminal?.proof?.source ?? "none"}:${terminal?.proof?.exitCode ?? "-"}`, proof: terminal?.proof ?? null };
});

writeReceipt(1, { title: "default proof: the project's own tests run when no proof is given", seconds: Math.round((Date.now() - started) / 1000), ok: results.every((r) => r.ok), results });
