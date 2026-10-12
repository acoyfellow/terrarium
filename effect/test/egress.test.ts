import assert from "node:assert/strict";
import { test } from "node:test";

import { OUTSIDE_TARGETS, parseProbe, probeCommand } from "../src/egress.ts";

test("the probe command is fixed and covers every outside target plus the model host", () => {
  const command = probeCommand("model.example.com");

  for (const url of OUTSIDE_TARGETS) assert.ok(command.includes(`'${url}'`));
  assert.ok(command.includes("https://model.example.com/_terrarium_model/v1/chat/completions"));
});

test("parseProbe reads codes, pi startup and secret-looking names", () => {
  const report = parseProbe("reach https://example.com/ 520\nreach https://x/ \npistartms 1900\nenvname API_TOKEN\n");

  assert.deepEqual(report.reachable, { "https://example.com/": "520", "https://x/": "000" });
  assert.equal(report.piStartupMs, 1900);
  assert.deepEqual(report.secretEnvNames, ["API_TOKEN"]);
});
