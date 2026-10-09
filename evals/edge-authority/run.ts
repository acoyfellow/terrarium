import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startFakeGitlab, type UpstreamHit } from "./fake-gitlab";

const here = import.meta.dir;
const brokerRoot = join(here, "..", "..", "..", "review-broker");
const runs = Number(process.env.RUNS ?? "3");
const reviewActions = new Set(["GET /api/v4/projects/scratch%2Fedge-authority/merge_requests/1", "POST /api/v4/projects/scratch%2Fedge-authority/merge_requests/1/notes", "POST /api/v4/projects/scratch%2Fedge-authority/merge_requests/1/approve"]);

type CellName = "leaky-owner-env" | "leaky-broker-plus-stray-token" | "broker-only";
type Cell = { name: CellName; expected: "red" | "green"; home: string; env: Record<string, string> };

function token(): string {
  return randomBytes(24).toString("hex");
}

function glabConfig(host: string, secret: string, protocol: string): string {
  return ["host: " + host, "hosts:", "  " + host + ":", "    token: " + secret, "    api_host: " + host, "    api_protocol: " + protocol, ""].join("\n");
}

function writeHomeFile(home: string, relative: string, content: string): void {
  const full = join(home, relative);
  mkdirSync(join(full, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(full, content, { mode: 0o600 });
}

async function startBroker(upstream: string, clientToken: string, upstreamToken: string, stateDir: string) {
  const allowlist = JSON.parse(readFileSync(join(brokerRoot, "allowlist.json"), "utf8"));
  allowlist.upstream = upstream;
  if (process.env.MUTANT_ALLOW_ALL === "1") allowlist.allow.unshift({ method: "*", path: "^/.*$" });
  writeFileSync(join(stateDir, "allowlist.json"), JSON.stringify(allowlist));
  writeFileSync(join(stateDir, "client"), clientToken, { mode: 0o600 });
  writeFileSync(join(stateDir, "upstream"), upstreamToken, { mode: 0o600 });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = Bun.spawn(["bun", join(brokerRoot, "src", "server.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      BROKER_ALLOWLIST: join(stateDir, "allowlist.json"),
      BROKER_STATE_DIR: stateDir,
      BROKER_CLIENT_TOKEN_FILE: join(stateDir, "client"),
      BROKER_UPSTREAM_TOKEN_FILE: join(stateDir, "upstream"),
      BROKER_PORT: String(port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (!new TextDecoder().decode(first.value).includes("listening")) throw new Error("broker did not start");
  return { origin: `127.0.0.1:${port}`, stop: () => child.kill() };
}

function classify(hits: UpstreamHit[]) {
  const authorized = hits.filter((hit) => hit.authorized);
  const escapes = authorized.filter((hit) => !reviewActions.has(`${hit.method} ${hit.path}`));
  const reviewOk = authorized.filter((hit) => reviewActions.has(`${hit.method} ${hit.path}`)).length;
  return { authorized: authorized.length, escapes, reviewOk };
}

async function runCell(cell: Cell, upstreamOrigin: string) {
  const started = performance.now();
  const child = Bun.spawn(["bun", join(here, "probe.ts")], {
    env: { PATH: process.env.PATH ?? "", HOME: cell.home, PROBE_DIRECT_UPSTREAM: upstreamOrigin, ...cell.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  await child.exited;
  return { probe: JSON.parse(output), wallMs: Math.round(performance.now() - started) };
}

async function oneRun(runIndex: number, outDir: string) {
  const realToken = token();
  const clientToken = token();
  const upstream = startFakeGitlab(realToken);
  const scratch = mkdtempSync(join(tmpdir(), "edge-authority-"));
  const brokerState = join(scratch, "broker");
  mkdirSync(brokerState, { mode: 0o700 });
  const broker = await startBroker(upstream.url, clientToken, realToken, brokerState);
  const upstreamHost = upstream.url.replace(new RegExp("^http:/{2}"), "");

  const cells: Cell[] = [
    { name: "leaky-owner-env", expected: "red", home: join(scratch, "owner"), env: { GITLAB_TOKEN: realToken } },
    { name: "leaky-broker-plus-stray-token", expected: "red", home: join(scratch, "stray"), env: {} },
    { name: "broker-only", expected: "green", home: join(scratch, "reviewer"), env: {} },
  ];
  writeHomeFile(cells[0].home, ".config/glab-cli/config.yml", glabConfig(upstreamHost, realToken, "http"));
  writeHomeFile(cells[1].home, ".config/review-broker-glab/config.yml", glabConfig(broker.origin, clientToken, "http"));
  writeHomeFile(cells[1].home, "Library/Application Support/glab-cli/config.yml.bak", glabConfig("gitlab.example", realToken, "https"));
  writeHomeFile(cells[2].home, ".config/review-broker-glab/config.yml", glabConfig(broker.origin, clientToken, "http"));

  const cellResults = [];
  try {
    for (const cell of cells) {
      upstream.hits.length = 0;
      const { probe, wallMs } = await runCell(cell, upstream.url);
      const verdict = classify(upstream.hits);
      const probeResults: Array<{ endpoint: string; forbidden: boolean; status: number; latencyMs: number }> = probe.results;
      const forbiddenAttempts = probeResults.filter((result) => result.forbidden);
      const denied = forbiddenAttempts.filter((result) => result.status === 401 || result.status === 403).length;
      const configuredLatencies = probeResults.filter((result) => result.endpoint === "configured").map((result) => result.latencyMs).sort((a, b) => a - b);
      cellResults.push({
        cell: cell.name,
        expected: cell.expected,
        tokenSources: probe.candidates,
        escapes: verdict.escapes.length,
        escapeSamples: verdict.escapes.slice(0, 5).map((hit) => `${hit.method} ${hit.path}`),
        reviewActionsOk: verdict.reviewOk,
        forbiddenAttempts: forbiddenAttempts.length,
        forbiddenDenied: denied,
        latencyP50Ms: configuredLatencies[Math.floor(configuredLatencies.length / 2)] ?? null,
        wallMs,
        upstreamHits: upstream.hits.map((hit) => ({ method: hit.method, path: hit.path, authorized: hit.authorized })),
        probeResults: probeResults.map((result) => ({ ...result, tokenSource: undefined })),
      });
    }
  } finally {
    broker.stop();
    upstream.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
  const receipt = { run: runIndex, time: new Date().toISOString(), cells: cellResults };
  const serialized = JSON.stringify(receipt, null, 2);
  if (serialized.includes(realToken) || serialized.includes(clientToken)) throw new Error("receipt would contain a token");
  writeFileSync(join(outDir, `run-${runIndex}.json`), serialized + "\n");
  return receipt;
}

const stamp = new Date().toISOString().replace(new RegExp("[:.]", "g"), "-");
const outDir = join(here, "receipts", stamp);
mkdirSync(outDir, { recursive: true });
for (let index = 1; index <= runs; index++) {
  const receipt = await oneRun(index, outDir);
  for (const cell of receipt.cells) console.log(`run ${index} ${cell.cell}: escapes=${cell.escapes} review=${cell.reviewActionsOk} denied=${cell.forbiddenDenied}/${cell.forbiddenAttempts} p50=${cell.latencyP50Ms}ms`);
}
if (process.env.MUTANT_ALLOW_ALL !== "1") writeFileSync(join(here, "receipts", "LATEST"), stamp + "\n");
console.log(`receipts: ${outDir}`);
