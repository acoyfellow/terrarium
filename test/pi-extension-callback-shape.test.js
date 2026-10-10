import test from "node:test";
import assert from "node:assert/strict";
import { claimedEvents, isTerrariumSpawnTool } from "../pi-extension/callback-shape.js";

test("the Pi extension recognizes every spawn tool name an MCP adapter produces", () => {
  for (const name of ["terrarium_spawn", "terrarium_spawn_batch", "terrarium_terrarium_spawn", "mcp__terrarium__terrarium_spawn", "mcp__terrarium__terrarium_spawn_batch"]) {
    assert.equal(isTerrariumSpawnTool(name), true, name);
  }
  for (const name of ["terrarium_status", "mcp__terrarium__terrarium_status", "my_terrarium_spawner", undefined]) {
    assert.equal(isTerrariumSpawnTool(name), false, String(name));
  }
});

test("the Pi extension reads claimed events from the deployed Pulse response shape", () => {
  const event = { type: "Completed", runId: "ter_x" };
  assert.deepEqual(claimedEvents({ ok: true, result: { subscriberId: "s", events: [event], quarantined: 0 } }), [event]);
  assert.deepEqual(claimedEvents({ events: [event] }), [event]);
  assert.deepEqual(claimedEvents({ ok: false, error: "unauthorized" }), []);
});
