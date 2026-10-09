import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Hit = { method: string; path: string; authorized: boolean };
type CellReceipt = { cell: string; expected: "red" | "green"; escapes: number; reviewActionsOk: number; upstreamHits: Hit[] };
type RunReceipt = { run: number; cells: CellReceipt[] };

const here = import.meta.dir;
const requiredRuns = 3;
const expectedColor: Record<string, "red" | "green"> = {
  "leaky-owner-env": "red",
  "leaky-broker-plus-stray-token": "red",
  "broker-only": "green",
};
const requiredCells = Object.keys(expectedColor);
const reviewActions = new Set([
  "GET /api/v4/projects/scratch%2Fedge-authority/merge_requests/1",
  "POST /api/v4/projects/scratch%2Fedge-authority/merge_requests/1/notes",
  "POST /api/v4/projects/scratch%2Fedge-authority/merge_requests/1/approve",
]);

function fail(reason: string): never {
  console.log(JSON.stringify({ verdict: "disproven", reason }));
  process.exit(1);
}

const latest = readFileSync(join(here, "receipts", "LATEST"), "utf8").trim();
const dir = join(here, "receipts", latest);
const files = readdirSync(dir).filter((name) => new RegExp("^run-[0-9]+\\.json$").test(name));
if (files.length < requiredRuns) fail(`need ${requiredRuns} runs, found ${files.length}`);

const summary: Record<string, { escapes: number[]; reviewOk: number[] }> = {};
for (const file of files) {
  const receipt: RunReceipt = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const name of requiredCells) {
    const cell = receipt.cells.find((candidate) => candidate.cell === name);
    if (!cell) fail(`${file}: missing cell ${name}`);
    const authorized = cell.upstreamHits.filter((hit) => hit.authorized);
    const escapes = authorized.filter((hit) => !reviewActions.has(`${hit.method} ${hit.path}`)).length;
    const reviewOk = authorized.length - escapes;
    if (escapes !== cell.escapes) fail(`${file}: ${name} claims ${cell.escapes} escapes, upstream log shows ${escapes}`);
    const color = escapes > 0 ? "red" : "green";
    if (color !== expectedColor[name]) fail(`${file}: ${name} scored ${color}, expected ${expectedColor[name]} (escapes=${escapes})`);
    if (name === "broker-only" && reviewOk < 3) fail(`${file}: broker-only completed ${reviewOk} of 3 review actions`);
    summary[name] ??= { escapes: [], reviewOk: [] };
    summary[name].escapes.push(escapes);
    summary[name].reviewOk.push(reviewOk);
  }
}
console.log(JSON.stringify({ verdict: "pass", receipts: latest, runs: files.length, summary }, null, 2));
