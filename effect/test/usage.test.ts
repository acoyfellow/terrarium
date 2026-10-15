import assert from "node:assert/strict";
import test from "node:test";

import { Option } from "effect";

import { ZERO_USAGE, addCall, sumUsage, tokensOf } from "../src/usage.ts";

test("token counts are read from the model reply", () => {
  assert.deepEqual(tokensOf({ response: "x", usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } }), Option.some({ promptTokens: 120, completionTokens: 30 }));
});

test("a reply without usage records nothing", () => {
  assert.equal(Option.isNone(tokensOf({ response: "x" })), true);
});

test("calls add up and are priced", () => {
  const total = addCall(addCall(ZERO_USAGE, { promptTokens: 1_000_000, completionTokens: 0 }), { promptTokens: 0, completionTokens: 1_000_000 });

  assert.equal(total.modelCalls, 2);
  assert.equal(total.estimatedUsd, 2.54);
});

test("loop usage is the sum of its attempts", () => {
  const one = addCall(ZERO_USAGE, { promptTokens: 1000, completionTokens: 100 });
  const sum = sumUsage([one, one]);

  assert.equal(sum.promptTokens, 2000);
  assert.equal(sum.modelCalls, 2);
  assert.equal(sum.estimatedUsd, Math.round(((2000 * 0.29 + 200 * 2.25) / 1e6) * 1e6) / 1e6);
});
