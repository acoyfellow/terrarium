import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LAB_POLICY, normalizeLabReceipt, runLabPayload, validateLabPayload } from "../src/lab.js";

test("Lab payload policy rejects empty, oversized, and forbidden inputs", () => {
  assert.throws(() => validateLabPayload({ body: "" }), /body required/);
  assert.throws(() => validateLabPayload({ body: "x".repeat(5000) }), /maxPayloadBytes/);
  assert.throws(() => validateLabPayload({ body: "return 1", capabilities: ["kvRead"] }), /capability not allowed/);
  assert.deepEqual(validateLabPayload({ body: "return 1", capabilities: [] }), { body: "return 1", capabilities: [] });
});

test("Lab payload adapter sends bounded request", async () => {
  const calls = [];
  const result = await runLabPayload({
    baseUrl: "https://lab.example",
    body: "return false;",
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, result: false, resultId: "r1" }) };
    },
  });
  assert.equal(result.result, false);
  assert.equal(calls[0].url, "https://lab.example/run");
  assert.deepEqual(JSON.parse(calls[0].options.body), { body: "return false;", capabilities: [] });
});

test("Lab receipt normalization distinguishes escaped and verified escape", () => {
  const contained = normalizeLabReceipt({ scenarioId: "x", body: "return false", run: { result: false, resultId: "a" } });
  assert.equal(contained.verdict, "contained");
  assert.equal(contained.replay, null);
  const escaped = normalizeLabReceipt({ scenarioId: "x", body: "return true", run: { result: true, resultId: "a" }, replay: { result: true, resultId: "b" } });
  assert.equal(escaped.verdict, "escaped");
  assert.equal(escaped.verifiedVerdict, "verified-escape");
  assert.equal(escaped.replay.resultId, "b");
});
