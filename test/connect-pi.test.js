import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPi } from "../src/connect-pi.js";

test("connectPi adds the Terrarium MCP server without touching other servers and links the callback extension", () => {
  const root = mkdtempSync(join(tmpdir(), "connect-pi-"));
  const env = { PI_AGENT_DIR: join(root, "agent"), TERRARIUM_HOME: join(root, "home") };
  mkdirSync(join(root, "agent", "extensions"), { recursive: true });
  writeFileSync(join(root, "agent", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, terrarium: { command: "old", env: { TERRARIUM_TOKEN_FILE: "/secret" } } } }));
  writeFileSync(join(root, "agent", "extensions", "terrarium-autocontinue.ts"), "old copy");

  const result = connectPi("https://terrarium.example.dev", env);

  const config = JSON.parse(readFileSync(result.mcpConfig, "utf8"));
  assert.deepEqual(config.mcpServers.other, { command: "x" });
  assert.deepEqual(config.mcpServers.terrarium.env, { TERRARIUM_URL: "https://terrarium.example.dev", TERRARIUM_ACCESS_LOGIN: "1" });
  assert.match(config.mcpServers.terrarium.args[0], /src[\\/]mcp\.js$/);
  assert.match(readlinkSync(result.extension), /pi-extension$/);
  assert.ok(existsSync(join(result.extension, "index.ts")));
  assert.ok(existsSync(join(result.extension, "callback-shape.js")));
  assert.equal(existsSync(join(root, "agent", "extensions", "terrarium-autocontinue.ts")), false);
  const backups = readdirSync(join(root, "home", "backups"));
  assert.ok(backups.some((name) => name.startsWith("mcp.json.bak-")));
  assert.ok(backups.some((name) => name.startsWith("terrarium-autocontinue.ts.bak-")));
  assert.equal(existsSync(join(root, "agent", "extensions", "terrarium-autocontinue.ts.bak")), false);

  const again = connectPi("https://terrarium.example.dev", env);
  assert.match(readlinkSync(again.extension), /pi-extension$/);
});
