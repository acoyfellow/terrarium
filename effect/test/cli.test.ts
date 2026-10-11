import assert from "node:assert/strict";
import { test } from "node:test";

import { withTerrariumServer } from "../src/client/cli.ts";

const URL = "https://terrarium.example.com";

test("login adds the terrarium server and keeps the other servers", () => {
  const written = JSON.parse(withTerrariumServer(JSON.stringify({ mcpServers: { other: { command: "x" } } }), URL, "/repo/mcp.ts"));

  assert.deepEqual(written.mcpServers.other, { command: "x" });
  assert.equal(written.mcpServers.terrarium.env.TERRARIUM_URL, URL);
  assert.equal(written.mcpServers.terrarium.args.at(-1), "/repo/mcp.ts");
});

test("login writes a fresh config when mcp.json is empty or broken", () => {
  for (const raw of ["", "{not json"]) assert.deepEqual(Object.keys(JSON.parse(withTerrariumServer(raw, URL, "/m.ts")).mcpServers), ["terrarium"]);
});
