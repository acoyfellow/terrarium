import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();

const metric = {
  command: "wc -c < out.txt",
  direction: "lower",
  seed: "Use bash to run exactly: head -c 2000 /dev/zero | tr '\\\\0' 'a' > out.txt . Then reply DONE.",
  baselineRuns: 2,
  target: 200,
};

const task = "Make out.txt smaller while keeping only the letter a in it. Use bash to run exactly: head -c 100 out.txt > out.tmp && mv out.tmp out.txt . Then reply DONE.";

const { status, json } = await api.call("/api/loops", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ goal: "borrow 13 metric ratchet", task, metric, maxAttempts: 2 }) });
const loopId = json.loopId;
const conflict = await api.call("/api/loops", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ goal: "g", task, metric, proof: "true" }) });

const finished = async () => {
  for (let poll = 0; poll < 240; poll += 1) {
    const { json: body } = await api.call(`/api/loops/${loopId}`);
    const record = body.loop ?? body;

    if (record.output !== null && record.output !== undefined) return record;

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  return null;
};

const loop = status === 202 ? await finished() : null;
const out = loop?.output?.metric;
const steps = out?.ratchet?.steps ?? [];
const baselineValues = out?.baseline?.values ?? [];
const attemptLogs = steps[0]?.runId ? ((await api.call(`/api/runs/${steps[0].runId}/logs`)).json.logs ?? "") : "";
const resumed = attemptLogs.includes("[terrarium:resume] restored workspace");

const results = [
  { name: "a metric loop is accepted and a metric+proof loop is refused", ok: status === 202 && conflict.status === 400, note: `${loopId} create=${status} conflict=${conflict.status}` },
  { name: "baseline: seed plus repeated idle runs measured the metric", ok: baselineValues.length === 3 && baselineValues.every((value) => value === 2000), note: `values=${JSON.stringify(baselineValues)} median=${out?.baseline?.median} noise=${out?.baseline?.noise}` },
  { name: "the attempt resumed from the best workspace and improved the metric", ok: resumed && steps[0]?.accepted === true && steps[0]?.value < 2000, note: `resumed=${resumed} ${JSON.stringify(steps[0] ?? null)}` },
  { name: "the ratchet stopped at the target", ok: loop?.output?.decision?.outcome === "passed" && String(out?.stoppedBecause ?? "").includes("target") && steps.length === 1, note: `${out?.stoppedBecause} best=${out?.ratchet?.best} bestRun=${out?.ratchet?.bestRunId}` },
];

writeReceipt(13, { title: "metric loops: measured baseline and noise, then a ratchet that keeps only real gains and resumes from the best workspace", loopId, seconds: Math.round((Date.now() - started) / 1000), ok: results.every((result) => result.ok), results });
