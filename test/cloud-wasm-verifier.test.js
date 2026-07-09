// E4: the portable WASM verifier re-checks a receipt artifact's content hash
// with no host trust — only the 1.5KB module + the artifact bytes. This proves
// the Stage-2 property: a third party (Worker/browser/other org) can confirm
// artifact integrity without the producer's code, data, or network.
//
// The .wasm is a checked-in build artifact under wasm-verifier/target. If it's
// absent (fresh checkout without a wasm build), the test skips rather than fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mintReceiptArtifact, _internals } from "../src/cloud/receipt-artifact.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const WASM = join(root, "wasm-verifier/target/wasm32-unknown-unknown/release/terrarium_receipt_verifier.wasm");

const contract = { runId: "ter_wasm_1", taskFingerprint: "fp00112233445566778899wz", nonce: "n-w-1" };
const terminal = { status: "done", ok: true, taskContractStatus: "verified", taskResultSummary: "42" };

async function loadVerifier() {
  const bytes = readFileSync(WASM);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Drive the WASM: write canonical body into BODY, expected id into EXPECTED,
// call verify(len). Uses the module's own linear memory + exported pointers.
function wasmVerify(ex, bodyStr, expectedHex) {
  const mem = new Uint8Array(ex.memory.buffer);
  const bodyBytes = new TextEncoder().encode(bodyStr);
  const bodyPtr = ex.body_ptr();
  const cap = ex.body_cap();
  assert.ok(bodyBytes.length <= cap, "body fits the wasm buffer");
  mem.set(bodyBytes, bodyPtr);
  const expPtr = ex.expected_ptr();
  mem.set(hexToBytes(expectedHex), expPtr);
  return ex.verify(bodyBytes.length) === 1;
}

test("wasm verifier confirms a genuine artifact content hash (portable, no host trust)", async (t) => {
  if (!existsSync(WASM)) { t.skip("wasm not built"); return; }
  const ex = await loadVerifier();
  const art = await mintReceiptArtifact({ contract, terminal, correctness: null });
  const canonicalBody = _internals.canonical(art.body);
  assert.equal(wasmVerify(ex, canonicalBody, art.artifactId), true);
});

test("wasm verifier rejects a tampered body (content hash no longer matches id)", async (t) => {
  if (!existsSync(WASM)) { t.skip("wasm not built"); return; }
  const ex = await loadVerifier();
  const art = await mintReceiptArtifact({ contract, terminal, correctness: null });
  const tampered = _internals.canonical(art.body).replace('"42"', '"999"');
  assert.equal(wasmVerify(ex, tampered, art.artifactId), false);
});

test("wasm SHA-256 matches the JS implementation exactly (cross-impl agreement)", async (t) => {
  if (!existsSync(WASM)) { t.skip("wasm not built"); return; }
  const ex = await loadVerifier();
  for (const s of ["", "abc", "the quick brown fox", "x".repeat(1000)]) {
    const jsHex = await _internals.sha256Hex(s);
    assert.equal(wasmVerify(ex, s, jsHex), true, `wasm must agree with JS sha256 for ${JSON.stringify(s.slice(0, 12))}`);
  }
});
