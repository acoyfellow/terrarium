import assert from "node:assert/strict";
import test from "node:test";

import { verifyReceipt } from "../src/receipt.ts";

const contract = { runId: "ter_20260721_abcdef012345", taskFingerprint: "fp_0011223344556677", nonce: "nonce-9f8e7d6c5b4a" };

const output = (receipt: string): string => `working...\ndid the work\nTERRARIUM_RESULT=${receipt}\n`;

const statusOf = (text: string): string => verifyReceipt(text, contract).provenance;

test("minimal receipt {nonce, summary} is verified with the summary", () => {
  assert.deepEqual(verifyReceipt(output(JSON.stringify({ nonce: contract.nonce, summary: "done it" })), contract), { provenance: "this-run", summary: "done it" });
});

test("full receipt echoing correct framing is verified", () => {
  assert.equal(statusOf(output(JSON.stringify({ ...contract, summary: "ok" }))), "this-run");
});

test("wrong nonce is mismatch", () => {
  assert.equal(statusOf(output(JSON.stringify({ nonce: "nope", summary: "ok" }))), "mismatch");
});

test("echoed wrong runId with correct nonce is mismatch", () => {
  assert.equal(statusOf(output(JSON.stringify({ runId: "ter_other0_000000000000", nonce: contract.nonce, summary: "ok" }))), "mismatch");
});

test("echoed wrong taskFingerprint is mismatch", () => {
  assert.equal(statusOf(output(JSON.stringify({ taskFingerprint: "fp_bad", nonce: contract.nonce, summary: "ok" }))), "mismatch");
});

test("missing summary is malformed", () => {
  assert.equal(statusOf(output(JSON.stringify({ nonce: contract.nonce }))), "malformed");
});

test("empty and oversized summaries are malformed", () => {
  assert.equal(statusOf(output(JSON.stringify({ nonce: contract.nonce, summary: "  " }))), "malformed");
  assert.equal(statusOf(output(JSON.stringify({ nonce: contract.nonce, summary: "x".repeat(2001) }))), "malformed");
});

test("extra keys are malformed", () => {
  assert.equal(statusOf(output(JSON.stringify({ nonce: contract.nonce, summary: "ok", verified: true }))), "malformed");
});

test("non-JSON and non-object receipts are malformed", () => {
  assert.equal(statusOf(output("{not json")), "malformed");
  assert.equal(statusOf(output("[1,2]")), "malformed");
});

test("no receipt line is missing, and model prose never verifies", () => {
  assert.equal(statusOf("I am done, verified!\n"), "missing");
});

test("more than one receipt line is malformed", () => {
  const line = JSON.stringify({ nonce: contract.nonce, summary: "ok" });
  assert.equal(statusOf(`${output(line)}${output(line)}`), "malformed");
});
