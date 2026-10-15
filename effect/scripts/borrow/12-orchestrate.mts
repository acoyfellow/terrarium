import { readFileSync } from "node:fs";

import { Effect } from "effect";

import { cloudBatchCalls, runBatch } from "../../pi-extension/batch.ts";
import { client, writeReceipt } from "./lib.mjs";

const [winnerId, ...loserIds] = process.argv.slice(2);
const word = readFileSync(`${process.env.HOME}/.terrarium/psub/word12.txt`, "utf8").trim();
const codemodeLog = readFileSync(`${process.env.HOME}/.terrarium/psub/p12.log`, "utf8");
const api = client();
const statusOf = async (runId: string) => (await api.call(`/api/runs/${runId}/status`)).json;
const winner = await statusOf(winnerId);
const losers = await Promise.all(loserIds.map(statusOf));

const quick = `quick${Date.now().toString(36)}`;
const input = { mode: "first" as const, channel: "borrow-12", proof: `grep -qx ${quick} answer.txt`, tasks: [`Use bash to run: echo ${quick} > answer.txt . Reply DONE.`, "Use bash to run: sleep 120; echo slow > answer.txt . Reply DONE."] };
const report = await Effect.runPromise(runBatch(input, cloudBatchCalls(api.url, input, `b12-${Date.now().toString(36)}`), 4000));
const slow = report.runs[1];
const slowAfter = await statusOf(slow.runId);

const results = [
  { name: "a codemode script called tools.terrarium_batch", ok: codemodeLog.includes("Script completed") && codemodeLog.includes("terrarium_batch first:"), note: "pi codemode, tools codemode,terrarium_batch" },
  { name: "the winner is the one run whose proof passes", ok: winner.terminal?.status === "done" && winner.terminal?.proof?.exitCode === 0 && String(winner.terminal?.proof?.command).includes(word), note: `${winnerId} ${winner.terminal?.status}` },
  { name: "the other runs failed their proof in prod", ok: losers.every((loser) => loser.terminal?.status === "failed" && loser.terminal?.proof?.exitCode !== 0), note: loserIds.join(" ") },
  { name: "first-pass returned before the slow run finished", ok: report.winner?.index === 0 && report.seconds < 110, note: `${report.seconds}s winner=${report.winner?.runId}` },
  { name: "the slow run was cancelled", ok: slowAfter.terminal?.status === "cancelled" || slowAfter.status === "cancelled", note: `${slow.runId} ${slowAfter.terminal?.status ?? slowAfter.status}` },
];

writeReceipt(12, { title: "codemode orchestration helper: tools.terrarium_batch (all / first-pass with cancel)", runs: [winnerId, ...loserIds, ...report.runs.map((run) => run.runId)], ok: results.every((result) => result.ok), results });
