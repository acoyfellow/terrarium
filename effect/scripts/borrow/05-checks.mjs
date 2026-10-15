import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();

const checks = [
  { name: "greet.js exists", command: "test -f greet.js" },
  { name: "greet says hello", command: "node -e \"process.exit(require('./greet.js').greet('x') === 'hello x' ? 0 : 1)\"" },
  { name: "a README mentions greet", command: "grep -qi greet README.md" },
];

const startLoop = async (task, maxAttempts) => {
  const { status, json } = await api.call("/api/loops", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ goal: "borrow 05 named checks", task, checks, maxAttempts }) });

  if (status !== 202) throw new Error(`loop ${status} ${JSON.stringify(json)}`);

  return json.loopId;
};

const finished = async (loopId) => {
  for (let poll = 0; poll < 150; poll += 1) {
    const { json } = await api.call(`/api/loops/${loopId}`);
    const record = json.loop ?? json;

    if (record.output !== null && record.output !== undefined) return record;

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  return null;
};

const partialId = await startLoop("Use bash to run exactly this, then finish: printf 'module.exports={greet:(n)=>\"hello \"+n}' > greet.js", 1);
const fullId = await startLoop("Use bash to run exactly this, then finish: printf 'module.exports={greet:(n)=>\"hello \"+n}' > greet.js && printf '# greet\\n' > README.md", 1);
const [partial, full] = await Promise.all([finished(partialId), finished(fullId)]);

const statesOf = (loop) => (loop?.output?.attempts?.at(-1)?.checks ?? []).map((check) => `${check.name}:${check.state}`);
const partialStates = statesOf(partial);
const fullStates = statesOf(full);

const { status: badStatus } = await api.call("/api/loops", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ goal: "g", task: "t", checks: [] }) });

await Promise.all([partialId, fullId].map((id) => api.call(`/api/loops/${id}`, { method: "DELETE" })));

const results = [
  { name: "partial work: each named check is scored on its own", ok: partialStates.join() === "greet.js exists:passed,greet says hello:passed,a README mentions greet:failed", note: partialStates.join(" | ") },
  { name: "partial work: the gate names the failing check and the loop does not pass", ok: partial?.output?.decision?.outcome === "exhausted" && String(partial?.output?.attempts?.at(-1)?.gate?.reason).includes("a README mentions greet"), note: partial?.output?.attempts?.at(-1)?.gate?.reason },
  { name: "full work: all checks pass and the loop passes", ok: fullStates.every((s) => s.endsWith(":passed")) && fullStates.length === 3 && full?.output?.decision?.outcome === "passed", note: `${fullStates.join(" | ")} -> ${full?.output?.decision?.outcome}` },
  { name: "an empty check list is refused", ok: badStatus === 400, note: String(badStatus) },
];

writeReceipt(5, { title: "named acceptance checks: each scored per attempt, the gate names what fails, /loops shows 2✓ 0○ 1✗", seconds: Math.round((Date.now() - started) / 1000), loops: [partialId, fullId], ok: results.every((r) => r.ok), results });
