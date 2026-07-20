// Regression: an in-process (directTools) MCP instance inherits the host Pi
// session's process.env. If that session started before cloud was configured,
// mcp.json's `env` block never reaches process.env, so the cloud vars are
// absent and every real spawn wrongly fails closed / runs local
// (BUGREPORT-2026-07-20-directtools-mcp-drops-cloud-env).
//
// Fix: cloudConfig() falls back to ~/.terrarium/config.json (cloudUrl +
// tokenFile/controlToken) when env is absent. Env still wins; fail-closed is
// preserved when neither env nor file resolves.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudConfig, cloudEnabled } from "../src/cloud-client.js";

function withHome(config, files = {}) {
  const home = mkdtempSync(join(tmpdir(), "terra-cfg-"));
  if (config) writeFileSync(join(home, "config.json"), JSON.stringify(config));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, name), body);
  return home;
}

test("config.json fallback resolves cloud when env is empty (the directTools bug)", () => {
  // Token lives in a file, referenced by an absolute path in config.json.
  const home = withHome(null, { "prod.tok": "tok-abc-123456\n" });
  writeFileSync(join(home, "config.json"), JSON.stringify({ cloudUrl: "https://terrarium.coey.dev", tokenFile: join(home, "prod.tok") }));
  const bareEnv = { TERRARIUM_HOME: home }; // no TERRARIUM_URL / TOKEN / TOKEN_FILE
  const r = cloudConfig(bareEnv);
  assert.equal(r.url, "https://terrarium.coey.dev");
  assert.equal(r.token, "tok-abc-123456");
  assert.equal(r.configured, true);
  assert.equal(cloudEnabled(bareEnv), true);
  rmSync(home, { recursive: true, force: true });
});

test("config.json controlToken (inline) also resolves", () => {
  const home = withHome({ cloudUrl: "https://terrarium.coey.dev", controlToken: "inline-token-xyz" });
  const r = cloudConfig({ TERRARIUM_HOME: home });
  assert.equal(r.configured, true);
  assert.equal(r.token, "inline-token-xyz");
  rmSync(home, { recursive: true, force: true });
});

test("env WINS over config.json (no regression when a session has the vars)", () => {
  const home = withHome({ cloudUrl: "https://file-value.example", controlToken: "file-token" });
  const r = cloudConfig({ TERRARIUM_HOME: home, TERRARIUM_URL: "https://env-value.example", TERRARIUM_CONTROL_TOKEN: "env-token" });
  assert.equal(r.url, "https://env-value.example");
  assert.equal(r.token, "env-token");
  rmSync(home, { recursive: true, force: true });
});

test("env URL + file token compose (partial env, file fills the gap)", () => {
  const home = withHome({ controlToken: "file-token-only" });
  const r = cloudConfig({ TERRARIUM_HOME: home, TERRARIUM_URL: "https://env-url.example" });
  assert.equal(r.url, "https://env-url.example");
  assert.equal(r.token, "file-token-only");
  assert.equal(r.configured, true);
  rmSync(home, { recursive: true, force: true });
});

test("no env and no config.json -> fail closed (unconfigured)", () => {
  const home = withHome(null); // empty home, no config.json
  const r = cloudConfig({ TERRARIUM_HOME: home });
  assert.equal(r.configured, false);
  assert.equal(cloudEnabled({ TERRARIUM_HOME: home }), false);
  rmSync(home, { recursive: true, force: true });
});

test("malformed config.json never throws (returns unconfigured)", () => {
  const home = mkdtempSync(join(tmpdir(), "terra-cfg-bad-"));
  writeFileSync(join(home, "config.json"), "{ not valid json ");
  assert.doesNotThrow(() => cloudConfig({ TERRARIUM_HOME: home }));
  assert.equal(cloudConfig({ TERRARIUM_HOME: home }).configured, false);
  rmSync(home, { recursive: true, force: true });
});

test("trailing slash on cloudUrl is normalized", () => {
  const home = withHome({ cloudUrl: "https://terrarium.coey.dev/", controlToken: "t" });
  assert.equal(cloudConfig({ TERRARIUM_HOME: home }).url, "https://terrarium.coey.dev");
  rmSync(home, { recursive: true, force: true });
});
