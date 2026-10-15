import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { client, writeReceipt } from "./lib.mjs";

const api = client();
const statePath = join(homedir(), ".terrarium", "b15-state.json");
const phase = process.argv[2] ?? "start";
const getLoop = async (loopId) => {
  const { json } = await api.call(`/api/loops/${loopId}`);

  return json.loop ?? json;
};

const waitFor = async (loopId, test, polls = 120) => {
  for (let poll = 0; poll < polls; poll += 1) {
    const loop = await getLoop(loopId);

    if (test(loop)) return loop;

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  return getLoop(loopId);
};

if (phase === "start") {
  const created = await api.call("/api/loops", { method: "POST", body: JSON.stringify({ goal: "borrow 15 approval", task: "Use bash to run: echo draft > note.txt . Reply with the word draft.", expect: "draft", approve: true, maxAttempts: 3 }) });
  const loopId = created.json.loopId;
  const first = await waitFor(loopId, (loop) => loop.pendingApproval !== null && loop.pendingApproval !== undefined);
  const plain = await api.call("/api/loops", { method: "POST", body: JSON.stringify({ goal: "b15 plain", task: "Reply ok.", expect: "ok", maxAttempts: 1 }) });
  const notAsking = await api.call(`/api/loops/${plain.json.loopId}/approval`, { method: "POST", body: JSON.stringify({ verdict: "approve" }) });
  const reject = await api.call(`/api/loops/${loopId}/approval`, { method: "POST", body: JSON.stringify({ verdict: "reject", note: "write final instead of draft" }) });
  const second = await waitFor(loopId, (loop) => loop.pendingApproval?.attempt === 2);

  writeFileSync(statePath, JSON.stringify({ loopId, first: first.pendingApproval, second: second.pendingApproval, notAsking: notAsking.status, reject: reject.status }));
  console.log(JSON.stringify({ loopId, firstPending: first.pendingApproval, secondPending: second.pendingApproval, notAsking: notAsking.status, reject: reject.status }));
}

if (phase === "finish") {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const done = await waitFor(state.loopId, (loop) => loop.output !== null && loop.output !== undefined, 40);
  const approvals = done.output?.approvals ?? [];
  const attempt2 = done.output?.attempts?.[1];
  const task2 = attempt2?.runId ? ((await api.call(`/api/runs/${attempt2.runId}/status`)).json.task ?? "") : "";

  const results = [
    { name: "attempt 1 passed its gate and the loop waited for the owner", ok: state.first?.attempt === 1 && typeof state.first?.runId === "string", note: JSON.stringify(state.first).slice(0, 200) },
    { name: "approval on a loop that does not ask is refused (409)", ok: state.notAsking === 409, note: `status=${state.notAsking}` },
    { name: "reject sent the owner's note into attempt 2", ok: state.reject === 202 && task2.includes("write final instead of draft"), note: task2.slice(-120) },
    { name: "attempt 2 waited for approval again", ok: state.second?.attempt === 2, note: JSON.stringify(state.second).slice(0, 160) },
    { name: "approve from the phone view stopped the loop as passed", ok: done.output?.decision?.outcome === "passed" && approvals.at(-1)?.approval?.verdict === "approve" && String(done.output?.decision?.reason).includes("approved by"), note: String(done.output?.decision?.reason ?? "no output").replace(new RegExp("[^\\s@]+@[^\\s@]+", "g"), "<owner email>") },
    { name: "the pending marker is gone after the decision", ok: done.pendingApproval === null, note: `pendingApproval=${JSON.stringify(done.pendingApproval)}` },
  ];

  writeReceipt(15, { title: "remote approval: approve:true loops wait for the owner after a passing attempt; approve or reject (with a note) from /loops, phone-sized", loopId: state.loopId, screenshot: "receipts/borrow/15-phone.png", ok: results.every((result) => result.ok), results });
}
