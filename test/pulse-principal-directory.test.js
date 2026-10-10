import test from "node:test";
import assert from "node:assert/strict";
import { authenticatePulseRequest } from "../src/cloud/principal-auth.js";

const bearer = (token) => new Request("https://pulse.example/claim", { method: "POST", headers: { authorization: `Bearer ${token}` } });
const directoryEnv = {
  TERRARIUM_PRINCIPALS: JSON.stringify([
    { id: "ax-alice", token: "control-alice", pulseToken: "pulse-alice" },
    { id: "ax-bob", token: "control-bob", pulseToken: "pulse-bob" },
  ]),
  TERRARIUM_PRINCIPAL_ID: "ax-terrarium",
  TERRARIUM_PULSE_TOKEN_CURRENT: "pulse-single",
};

test("a principal directory pulse token authenticates Pulse as that principal", () => {
  assert.deepEqual(authenticatePulseRequest(bearer("pulse-alice"), directoryEnv), { ok: true, principalId: "ax-alice" });
  assert.deepEqual(authenticatePulseRequest(bearer("pulse-bob"), directoryEnv), { ok: true, principalId: "ax-bob" });
});

test("a control token never authenticates Pulse through the directory", () => {
  assert.equal(authenticatePulseRequest(bearer("control-alice"), directoryEnv).ok, false);
});

test("the legacy PULSE_TOKEN is still refused when a directory is configured", () => {
  const env = { ...directoryEnv, PULSE_TOKEN: "pulse-alice" };
  assert.equal(authenticatePulseRequest(bearer("pulse-alice"), env).ok, false);
});

test("a directory without pulse tokens keeps the single-principal Pulse token path", () => {
  const env = { ...directoryEnv, TERRARIUM_PRINCIPALS: JSON.stringify([{ id: "ax-alice", token: "control-alice" }]) };
  assert.deepEqual(authenticatePulseRequest(bearer("pulse-single"), env), { ok: true, principalId: "ax-terrarium" });
});
