import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();

const runId = await api.admit({ task: "Use bash to write the word hello to /workspace/hi.txt, then reply DONE.", channel: "borrow-02" });
const run = await api.waitFor(runId);
const usage = run?.terminal?.usage ?? null;

const { status: loopStatus, json: loopJson } = await api.call("/api/loops", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ goal: "borrow 02 loop usage", task: "What is 6 times 7? Reply with just the number.", expect: "999", maxAttempts: 2 }) });
const loopId = loopJson.loopId;

const loop = await (async () => {
  for (let poll = 0; poll < 120; poll += 1) {
    const { json } = await api.call(`/api/loops/${loopId}`);
    const record = json.loop ?? json;

    if (record.output !== null && record.output !== undefined) return record;

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  return null;
})();

const loopUsage = loop?.output?.usage ?? null;
const attemptUsage = (loop?.output?.attempts ?? []).map((attempt) => attempt.usage ?? null);
const attemptSum = attemptUsage.reduce((sum, item) => sum + (item?.promptTokens ?? 0), 0);

await api.call(`/api/loops/${loopId}`, { method: "DELETE" });

const results = [
  { name: "a run with real work reports model calls and tokens", ok: usage !== null && usage.modelCalls >= 1 && usage.promptTokens > 0 && usage.completionTokens > 0, note: JSON.stringify(usage) },
  { name: "the run reports an estimated price with its basis", ok: usage !== null && usage.estimatedUsd > 0 && usage.priceBasis.includes("$"), note: `$${usage?.estimatedUsd}` },
  { name: "a loop was admitted", ok: loopStatus === 202, note: `${loopStatus} ${loopId}` },
  { name: "each loop attempt reports its own usage", ok: attemptUsage.length === 2 && attemptUsage.every((item) => item !== null && item.modelCalls >= 1), note: JSON.stringify(attemptUsage.map((item) => item?.promptTokens ?? null)) },
  { name: "the loop total is the sum of its attempts", ok: loopUsage !== null && loopUsage.promptTokens === attemptSum && attemptSum > 0, note: `${loopUsage?.promptTokens} = ${attemptSum}` },
];

writeReceipt(2, { title: "cost: model calls, tokens and an estimated price per run and per loop", seconds: Math.round((Date.now() - started) / 1000), runId, loopId, ok: results.every((r) => r.ok), results });
