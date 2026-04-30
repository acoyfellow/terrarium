import test from "node:test";
import assert from "node:assert/strict";
import { childPrompt, splitCommand } from "../src/core.js";

test("builds a constrained child prompt", () => {
  assert.match(childPrompt("ship it", { depth: 1, maxDepth: 3 }), /Do not fan out/);
  assert.deepEqual(splitCommand('node -e "console.log(1)"'), ["node", "-e", "console.log(1)"]);
});
