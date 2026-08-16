import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRunStatus, runTaskProof, spawnTerrariumBackground, validateTaskContractOutput } from "../src/core.js";
import { clearInheritedTerrariumEnv } from "./helpers/terrarium-env.js";

clearInheritedTerrariumEnv();

async function waitForTerminal(runId, { attempts = 80, delayMs = 40 } = {}) {
  let status;
  for (let i = 0; i < attempts; i++) {
    status = await getRunStatus({ runId, staleMs: 5000 });
    if (status.status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return status;
}

function echoReceiptAgent(dir, summary) {
  const scriptPath = join(dir, "echo-receipt.mjs");
  writeFileSync(scriptPath, `import { readFileSync } from "node:fs";
const arg = process.argv.at(-1);
const text = process.env.TERRARIUM_PROMPT_FILE ? readFileSync(process.env.TERRARIUM_PROMPT_FILE, "utf8") : String(arg ?? "");
const line = text.split("\\n").find((value) => value.includes("TERRARIUM_RESULT="));
if (!line) {
  console.error("no receipt template");
  process.exit(2);
}
const receipt = JSON.parse(line.slice(line.indexOf("TERRARIUM_RESULT=") + "TERRARIUM_RESULT=".length));
receipt.summary = ${JSON.stringify(summary)};
console.log("TERRARIUM_RESULT=" + JSON.stringify(receipt));
`);
  return `${process.execPath} ${scriptPath}`;
}

const expected = { runId: "ter_20260803120000000_proof1", taskFingerprint: "fp-abc", nonce: "nonce-1" };
const fabricated = `TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary: "Created MRs for TICKET-A and TICKET-B" })}`;

test("a fabricated receipt still passes contract validation, which is why a proof is required", () => {
  assert.equal(validateTaskContractOutput(fabricated, expected).status, "verified");
});

test("a proof command that fails marks the run unproven despite the perfect receipt", async () => {
  const proof = await runTaskProof("exit 1");
  assert.equal(proof.status, "failed");
  assert.equal(proof.exitCode, 1);
});

test("a proof command that succeeds proves the work", async () => {
  const proof = await runTaskProof("exit 0");
  assert.equal(proof.status, "proved");
  assert.equal(proof.exitCode, 0);
});

test("a proof checks the real filesystem, not the child's claim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  const missing = await runTaskProof("test -f delivered.txt", { cwd: dir });
  assert.equal(missing.status, "failed");
  writeFileSync(join(dir, "delivered.txt"), "real work\n");
  const present = await runTaskProof("test -f delivered.txt", { cwd: dir });
  assert.equal(present.status, "proved");
});

test("no proof means not-required, so existing runs are unchanged", async () => {
  assert.equal((await runTaskProof(null)).status, "not-required");
  assert.equal((await runTaskProof(undefined)).status, "not-required");
});

test("an empty or non-string proof is rejected rather than silently skipped", async () => {
  assert.equal((await runTaskProof("   ")).status, "invalid");
  assert.equal((await runTaskProof(42)).status, "invalid");
});

test("a hanging proof times out instead of blocking the run forever", async () => {
  const proof = await runTaskProof("sleep 30", { timeoutMs: 300 });
  assert.equal(proof.status, "timeout");
});

test("proof output is captured and bounded so a chatty command cannot flood the record", async () => {
  const proof = await runTaskProof("printf 'evidence-line\\n'");
  assert.match(proof.output, /evidence-line/);
  const flood = await runTaskProof("yes abcdefgh | head -c 20000");
  assert.ok(flood.output.length <= 4096);
});

test("stderr is captured too, so a failing proof explains itself", async () => {
  const proof = await runTaskProof("echo 'no such merge request' >&2; exit 3");
  assert.equal(proof.status, "failed");
  assert.equal(proof.exitCode, 3);
  assert.match(proof.output, /no such merge request/);
});

test("a background receipt is unproven when the host proof fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-bg-"));
  const started = await spawnTerrariumBackground({
    task: "claim a missing file",
    cwd: dir,
    agent: echoReceiptAgent(dir, "claimed the file exists"),
    requireTaskContract: true,
    taskProof: "test -f delivered.txt",
    timeoutMs: 5000,
  });
  const status = await waitForTerminal(started.runId);
  assert.equal(status.status, "inconclusive");
  assert.equal(status.ok, false);
  assert.equal(status.taskContractStatus, "unproven");
  assert.equal(status.taskProofStatus, "failed");
});

test("a background receipt stays verified when the host proof passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-ok-"));
  writeFileSync(join(dir, "delivered.txt"), "real work\n");
  const started = await spawnTerrariumBackground({
    task: "prove a present file",
    cwd: dir,
    agent: echoReceiptAgent(dir, "file is present"),
    requireTaskContract: true,
    taskProof: "test -f delivered.txt",
    timeoutMs: 5000,
  });
  const status = await waitForTerminal(started.runId);
  assert.equal(status.status, "done");
  assert.equal(status.ok, true);
  assert.equal(status.taskContractStatus, "verified");
  assert.equal(status.taskProofStatus, "proved");
});
