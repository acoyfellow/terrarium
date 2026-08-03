import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskProof, validateTaskContractOutput } from "../src/core.js";

const expected = { runId: "ter_20260803120000000_proof1", taskFingerprint: "fp-abc", nonce: "nonce-1" };
const fabricated = `TERRARIUM_RESULT=${JSON.stringify({ ...expected, summary: "Created MRs for CFSA-663 and CFSA-456" })}`;

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
