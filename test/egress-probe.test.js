import { test } from "node:test";
import assert from "node:assert/strict";
import { egressProbeCommand, parseEgressProbeOutput, handleEgressProbe, EGRESS_PROBE_TARGETS } from "../src/cloud/egress-probe.js";

test("probe command covers every fixed target and no caller input", () => {
  const command = egressProbeCommand();
  for (const url of EGRESS_PROBE_TARGETS) assert.ok(command.includes(url));
});

test("parser maps status codes and secret env names", () => {
  const parsed = parseEgressProbeOutput("https://example.com/ 000\nhttps://terrarium.coey.dev/x 200\nenvname GITLAB_TOKEN\n");
  assert.deepEqual(parsed.reachable, { "https://example.com/": "000", "https://terrarium.coey.dev/x": "200" });
  assert.deepEqual(parsed.secretEnvNames, ["GITLAB_TOKEN"]);
});

test("unauthenticated callers get 401 and no sandbox", async () => {
  let started = false;
  const response = await handleEgressProbe(new Request("https://x/api/egress-probe"), {}, { getSandbox: () => { started = true; } });
  assert.equal(response.status, 401);
  assert.equal(started, false);
});
