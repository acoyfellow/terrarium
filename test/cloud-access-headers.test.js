import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessServiceTokenHeaders, cloudConfig, pulseConfig } from "../src/cloud-client.js";

test("Access service-token headers come from env or secret files and stay empty otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-access-"));
  try {
    assert.deepEqual(accessServiceTokenHeaders({ TERRARIUM_HOME: dir }, {}), {});
    writeFileSync(join(dir, "id"), "client-id\n");
    writeFileSync(join(dir, "secret"), "client-secret\n");
    const fromFiles = accessServiceTokenHeaders({}, { accessClientIdFile: join(dir, "id"), accessClientSecretFile: join(dir, "secret") });
    assert.deepEqual(fromFiles, { "cf-access-client-id": "client-id", "cf-access-client-secret": "client-secret" });
    const onlyId = accessServiceTokenHeaders({ TERRARIUM_ACCESS_CLIENT_ID: "a" }, {});
    assert.deepEqual(onlyId, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cloud and pulse configs carry the Access headers", () => {
  const env = { TERRARIUM_HOME: "/nonexistent", TERRARIUM_URL: "https://x.example", TERRARIUM_CONTROL_TOKEN: "t", TERRARIUM_PULSE_TOKEN: "p", TERRARIUM_ACCESS_CLIENT_ID: "i", TERRARIUM_ACCESS_CLIENT_SECRET: "s" };
  assert.deepEqual(cloudConfig(env).accessHeaders, { "cf-access-client-id": "i", "cf-access-client-secret": "s" });
  assert.deepEqual(pulseConfig(env).accessHeaders, { "cf-access-client-id": "i", "cf-access-client-secret": "s" });
});
