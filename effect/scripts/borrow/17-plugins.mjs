import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();
const token = `plug${Math.floor(Math.random() * 900000 + 100000)}`;

const source = [
  "import { writeFileSync } from \"node:fs\";",
  "export default function (pi) {",
  "  pi.on(\"session_start\", () => { writeFileSync(\"/workspace/plugin-hook.txt\", \"hook ran\\n\"); });",
  "  pi.registerTool({",
  "    name: \"stamp\",",
  "    label: \"Stamp\",",
  "    description: \"Writes the run stamp to /workspace/stamp.txt. Call it with no arguments.\",",
  "    parameters: { type: \"object\", properties: {}, required: [] },",
  `    execute: async () => { writeFileSync("/workspace/stamp.txt", "${token}\\n"); return { content: [{ type: "text", text: "stamped" }], details: {} }; },`,
  "  });",
  "}",
].join("\n");

const plugins = [{ name: "stamp", source, tools: ["stamp"] }];
const proof = `grep -qx ${token} stamp.txt && grep -qx 'hook ran' plugin-hook.txt`;
const task = "You have a tool named stamp. Invoke the stamp tool directly as a tool call (not through bash), with no arguments. Do not write stamp.txt yourself. Then reply DONE.";

const runId = await api.admit({ task, proof, plugins, channel: "borrow-17" });
const plain = await api.admit({ task, proof, channel: "borrow-17" });
const [run, control] = await Promise.all([api.waitFor(runId), api.waitFor(plain)]);
const logs = (await api.call(`/api/runs/${runId}/logs`)).json.logs ?? "";
const calls = ((await api.call(`/api/runs/${runId}/activity`)).json.events ?? []).filter((event) => event.kind === "tool").map((event) => event.detail);
const traversal = await api.call("/api/runs", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ task: "x", plugins: [{ name: "../evil", source: "x" }] }) });
const duplicate = await api.call("/api/runs", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ task: "x", plugins: [{ name: "a", source: "x" }, { name: "a", source: "y" }] }) });

const results = [
  { name: "the plugin loaded in the box", ok: logs.includes("[terrarium:plugins] loaded stamp"), note: `${runId} calls=${JSON.stringify(calls).slice(0, 200)}` },
  { name: "the plugin tool and hook ran (proof checks files only plugin code writes)", ok: run.terminal?.proof?.exitCode === 0 && run.terminal?.status === "done", note: `status=${run.terminal?.status} proof=${JSON.stringify(run.terminal?.proof ?? null).slice(0, 200)}` },
  { name: "the same task without the plugin fails its proof", ok: (control.terminal?.proof?.exitCode ?? 1) !== 0 && control.terminal?.status === "failed", note: `${plain} status=${control.terminal?.status}` },
  { name: "a plugin name with a path is refused", ok: traversal.status === 400, note: `status=${traversal.status}` },
  { name: "duplicate plugin names are refused", ok: duplicate.status === 400, note: `status=${duplicate.status}` },
];

writeReceipt(17, { title: "plugins per run: owner-supplied pi extensions loaded into that run's box only", seconds: Math.round((Date.now() - started) / 1000), runs: [runId, plain], ok: results.every((result) => result.ok), results });
