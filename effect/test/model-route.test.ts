import assert from "node:assert/strict";
import test from "node:test";

import { Option, Schema } from "effect";

import { answerOf, decodeModelOutput, modelInput } from "../src/model-route.ts";

const answerFrom = (raw: Schema.Json) => Option.map(decodeModelOutput(raw), answerOf);

const writeTool = { type: "function", function: { name: "write", description: "Write a file", parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } } } };

test("modelInput passes tools and tool messages through", () => {
  const input = modelInput({
    messages: [
      { role: "user", content: "make a.txt" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "write", arguments: "{}" } }] },
      { role: "tool", content: "ok", tool_call_id: "t1" },
    ],
    tools: [writeTool],
  });

  assert.equal(input.messages[1].content, "");
  assert.equal(input.messages[1].tool_calls?.[0].id, "t1");
  assert.equal(input.messages[2].tool_call_id, "t1");
  assert.equal(input.tools?.[0].function.name, "write");
});

test("modelInput omits an empty tool list", () => {
  assert.equal(modelInput({ messages: [{ role: "user", content: "hi" }], tools: [] }).tools, undefined);
});

test("answerOf reads OpenAI-style tool calls", () => {
  const answer = answerFrom({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write", arguments: "{}" } }] } }] });

  assert.deepEqual(Option.getOrThrow(answer), { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "write", arguments: "{}" } }] });
});

test("answerOf reads the legacy response shape", () => {
  assert.deepEqual(Option.getOrThrow(answerFrom({ response: "391" })), { content: "391", toolCalls: [] });
});

test("answerOf rejects anything else", () => {
  assert.equal(Option.isNone(answerFrom({ nope: true })), true);
});
