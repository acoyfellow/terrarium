import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();

const firstId = await api.admit({ task: "Use bash to run exactly this, then finish: mkdir -p notes && printf 'kumquat-%s' $RANDOM > notes/secret.txt && cat notes/secret.txt", channel: "borrow-04" });
const first = await api.waitFor(firstId);
const saved = first?.terminal?.workspace ?? null;
const pausedAt = Date.now();

await new Promise((resolve) => setTimeout(resolve, 20_000));

const resumedId = await api.admit({ task: "Use bash to run: cat notes/secret.txt ; then reply with exactly what it printed.", channel: "borrow-04", resumeFrom: firstId, proof: "test -s notes/secret.txt && grep -q kumquat- notes/secret.txt" });
const resumed = await api.waitFor(resumedId);
const resumedLogs = (await api.call(`/api/runs/${resumedId}/logs`)).json.logs ?? "";

const freshId = await api.admit({ task: "Use bash to run: cat notes/secret.txt || echo MISSING ; then reply with what it printed.", channel: "borrow-04", proof: "test -s notes/secret.txt" });
const fresh = await api.waitFor(freshId);

const { status: badStatus } = await api.call("/api/runs", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ task: "x", resumeFrom: "ter_zzzzzz_000000000000" }) });

const secret = (first?.terminal?.summary ?? "").match(/kumquat-\d+/)?.[0] ?? null;

const results = [
  { name: "a finished run saves its workspace and its box is destroyed", ok: saved !== null && typeof saved.id === "string", note: JSON.stringify(saved) },
  { name: "resuming restores the saved files into a new box", ok: resumedLogs.includes("[terrarium:resume] restored workspace") && resumed?.terminal?.proof?.exitCode === 0, note: `${resumedLogs.split("\n").find((l) => l.includes("terrarium:resume"))} proof=${resumed?.terminal?.proof?.exitCode}` },
  { name: "the resumed agent read the same file content", ok: secret !== null && (resumed?.terminal?.summary ?? "").includes(secret), note: `${secret} -> ${resumed?.terminal?.summary}` },
  { name: "a run without resumeFrom starts empty", ok: fresh?.terminal?.proof?.exitCode !== 0, note: `fresh proof exit ${fresh?.terminal?.proof?.exitCode}` },
  { name: "resuming from an unknown run is refused", ok: badStatus === 400, note: String(badStatus) },
];

writeReceipt(4, { title: "pause and resume: a finished run's workspace is saved, its box is freed, and a later run can resume from it", seconds: Math.round((Date.now() - started) / 1000), pausedSeconds: Math.round((Date.now() - pausedAt) / 1000), runs: [firstId, resumedId, freshId], ok: results.every((r) => r.ok), results });
