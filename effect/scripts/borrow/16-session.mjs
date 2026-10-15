import { client, writeReceipt } from "./lib.mjs";

const api = client();
const session = `b16-${Date.now().toString(36)}`;
const word = `kestrel${Math.floor(Math.random() * 9000 + 1000)}`;

const turn = async (text) => {
  const { status, json } = await api.call(`/api/sessions/${session}/turn`, { method: "POST", body: JSON.stringify({ text }) });

  return { status, ...json };
};

const first = await turn(`Use the write tool to create /workspace/secret.txt containing exactly the word ${word}. Then use bash to run: cat /workspace/secret.txt . Then reply with the word.`);
const replaced = (await api.call(`/api/sessions/${session}/replace-box`, { method: "POST" })).json;
const second = await turn("What word did you write to secret.txt in your earlier turn? Use bash to run: ls /workspace . Reply with the word, and say whether secret.txt still exists.");
const other = await api.call(`/api/sessions/${session}.x/turn`, { method: "POST", body: JSON.stringify({ text: "hi" }) });

const usedTool = (calls) => (calls ?? []).some((call) => call.startsWith("write") || call.startsWith("bash"));

console.log(JSON.stringify({ first: [first.stop, first.error, first.roles], second: [second.stop, second.error, second.roles] }));

const results = [
  { name: "turn 1 ran tools in a Terrarium box", ok: first.status === 200 && usedTool(first.toolCalls), note: `box=${first.box} tools=${JSON.stringify(first.toolCalls ?? first.error)}`.slice(0, 400) },
  { name: "turn 1 answer has the word", ok: (first.answer ?? "").includes(word), note: (first.answer ?? "").slice(0, 200) },
  { name: "the box was destroyed and replaced", ok: replaced.ok === true && replaced.old === first.box && replaced.fresh !== first.box, note: `${replaced.old} -> ${replaced.fresh}` },
  { name: "turn 2 ran in the new box", ok: second.status === 200 && second.box === replaced.fresh, note: `box=${second.box} tools=${JSON.stringify(second.toolCalls ?? second.error)}`.slice(0, 400) },
  { name: "turn 2 recalls turn 1 from the DO session, not the box", ok: (second.answer ?? "").includes(word) && second.userTurns === 2, note: `userTurns=${second.userTurns} answer=${(second.answer ?? "").slice(0, 240)}` },
  { name: "a bad session name is refused", ok: other.status === 400, note: `status=${other.status}` },
];

writeReceipt(16, { item: 16, title: "durable pi session in a DO, tools in the box", session, word, ms: { first: first.ms, second: second.ms }, ok: results.every((result) => result.ok), results });
