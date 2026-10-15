import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();
const repo = { github: process.env.BORROW07_REPO ?? "jonschlinkert/is-odd", ref: process.env.BORROW07_REF ?? "master" };

const runId = await api.admit({
  task: "This workspace is a git checkout of a small library. Read the README and index.js. Then add a short section to README.md titled '## Terrarium was here' with one sentence. Do not change any other file. Then finish.",
  channel: "borrow-07",
  repo,
  proof: "test -f index.js && grep -q 'Terrarium was here' README.md",
});
const run = await api.waitFor(runId);
const terminal = run?.terminal ?? null;
const result = terminal?.repo ?? null;
const logs = (await api.call(`/api/runs/${runId}/logs`)).json.logs ?? "";

const sealedId = await api.admit({ task: "Use bash to run: git ls-remote https://github.com/jonschlinkert/is-odd > /workspace/net.txt 2>&1; echo exit=$? >> /workspace/net.txt; cat /workspace/net.txt ; then finish.", channel: "borrow-07", repo, proof: "grep -q 'exit=[1-9]' net.txt" });
const sealed = await api.waitFor(sealedId);

const { status: badStatus } = await api.call("/api/runs", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ task: "x", repo: { github: "evil.com/../../etc" } }) });

const results = [
  { name: "the repo was checked out into the box on a session branch", ok: logs.includes(`[terrarium:repo] ${repo.github}@${repo.ref} on branch terrarium/${runId}`), note: logs.split("\n").find((l) => l.includes("[terrarium:repo]")) },
  { name: "the run result names the branch and base commit", ok: result?.branch === `terrarium/${runId}` && /^[0-9a-f]{40}$/.test(result?.baseCommit ?? ""), note: `${result?.branch} ${result?.baseCommit}` },
  { name: "the agent edited the real file and the proof checked it", ok: terminal?.status === "done" && terminal?.proof?.exitCode === 0, note: `${terminal?.status} proof=${terminal?.proof?.exitCode}` },
  { name: "the result carries the diff against the base", ok: (result?.diff ?? "").includes("README.md") && (result?.diff ?? "").includes("+## Terrarium was here"), note: (result?.diff ?? "").split("\n").slice(0, 3).join(" | ") },
  { name: "the box with a repo is still sealed: git cannot reach GitHub", ok: sealed?.terminal?.proof?.exitCode === 0, note: `proof=${sealed?.terminal?.proof?.exitCode} ${sealed?.terminal?.summary?.slice(0, 120) ?? ""}` },
  { name: "a repo spec that is not owner/name is refused", ok: badStatus === 400, note: String(badStatus) },
];

writeReceipt(7, { title: "repo in the box: the Worker fetches a GitHub archive, the box gets a git checkout on a session branch, the result carries the diff", seconds: Math.round((Date.now() - started) / 1000), repo, runs: [runId, sealedId], ok: results.every((r) => r.ok), results });
