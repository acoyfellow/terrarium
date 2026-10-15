import assert from "node:assert/strict";
import test from "node:test";

import { Schema } from "effect";

import { Plugins, agentTools, pluginEnv, pluginLine, pluginProblems } from "../src/plugins.ts";

const decode = Schema.decodeUnknownOption(Plugins);

test("valid plugins decode and map to box paths", () => {
  const plugins = [{ name: "stamp", source: "export default () => {}" }, { name: "lint-gate", source: "x" }];

  assert.equal(decode(plugins)._tag, "Some");
  assert.equal(pluginEnv(plugins), "/tmp/terrarium-plugins/stamp.ts:/tmp/terrarium-plugins/lint-gate.ts");
  assert.equal(pluginLine(plugins), "[terrarium:plugins] loaded stamp, lint-gate");
  assert.equal(pluginLine([]), "");
});

test("names that could escape the plugin dir are refused", () => {
  ["../x", "a/b", "A", "", "x".repeat(41), "a:b"].forEach((name) => assert.equal(decode([{ name, source: "x" }])._tag, "None", name));
});

test("too many, too large, empty and duplicate plugins are refused", () => {
  assert.equal(decode(Array.from({ length: 5 }, (_, index) => ({ name: `p${index}`, source: "x" })))._tag, "None");
  assert.equal(decode([{ name: "big", source: "x".repeat(20_001) }])._tag, "None");
  assert.equal(decode([{ name: "empty", source: "" }])._tag, "None");
  assert.deepEqual(pluginProblems([{ name: "a", source: "x" }, { name: "a", source: "y" }]), ["plugin names must be unique"]);
});

test("plugin tools join the base allowlist once", () => {
  assert.equal(agentTools([]), "read,write,edit,bash");
  assert.equal(agentTools([{ name: "a", source: "x", tools: ["stamp", "bash"] }, { name: "b", source: "y", tools: ["stamp"] }]), "read,write,edit,bash,stamp");
  assert.equal(decode([{ name: "a", source: "x", tools: ["Bad-Name"] }])._tag, "None");
});
