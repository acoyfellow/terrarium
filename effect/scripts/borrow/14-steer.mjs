import { client, writeReceipt } from "./lib.mjs";

const api = client();
const session = `b14-${Date.now().toString(36)}`;
const word = `heron${Math.floor(Math.random() * 9000 + 1000)}`;
const post = (path, body) => api.call(`/api/sessions/${session}/${path}`, { method: "POST", body: JSON.stringify(body) });

const idle = await post("steer", { text: "nothing is running" });
const turnPromise = post("turn", { text: "Use bash to run exactly: sleep 25 && echo slept > slept.txt . Then use bash to run: ls /workspace . Then reply with the file list." });

await new Promise((resolve) => setTimeout(resolve, 12000));

const steer = await post("steer", { text: `New instruction from the owner while you work: also use the write tool to create /workspace/steered.txt containing exactly ${word}. Then run ls /workspace again and mention steered.txt in your reply.` });
const turn = await turnPromise;
const check = await post("turn", { text: "Use bash to run: cat /workspace/steered.txt . Reply with its content only." });
const calls = turn.json.toolCalls ?? [];

const results = [
  { name: "steering an idle session is refused (409)", ok: idle.status === 409, note: `status=${idle.status}` },
  { name: "steering while the turn ran was accepted (202)", ok: steer.status === 202, note: `status=${steer.status} ${JSON.stringify(steer.json).slice(0, 160)}` },
  { name: "the running turn acted on the steer: it wrote steered.txt", ok: calls.some((call) => call.includes("steered.txt") && call.includes(word)), note: JSON.stringify(calls).slice(0, 400) },
  { name: "the turn finished its original work too", ok: calls.some((call) => call.includes("sleep 25")), note: `turn status=${turn.status} answer=${String(turn.json.answer ?? "").slice(0, 160)}` },
  { name: "the steered file is in the box with the word", ok: String(check.json.answer ?? "").includes(word), note: String(check.json.answer ?? "").slice(0, 120) },
];

writeReceipt(14, { title: "steer a running session turn: POST /api/sessions/:name/steer queues a steering message into the live pi-durable turn", session, word, ok: results.every((result) => result.ok), results });
