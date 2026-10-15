import assert from "node:assert/strict";
import test from "node:test";

import { baseKey, isSetupRequest } from "../src/warm-base.ts";

test("only read-only HTTPS requests to the package registry are setup traffic", () => {
  assert.equal(isSetupRequest(new Request("https://registry.npmjs.org/is-number")), true);
  assert.equal(isSetupRequest(new Request("https://registry.npmjs.org/x", { method: "HEAD" })), true);
  assert.equal(isSetupRequest(new Request("https://registry.npmjs.org/x", { method: "PUT", body: "x" })), false);
  assert.equal(isSetupRequest(new Request("http://registry.npmjs.org/x")), false);
  assert.equal(isSetupRequest(new Request("https://example.com/")), false);
  assert.equal(isSetupRequest(new Request("https://registry.npmjs.org.evil.com/")), false);
});

test("a base key depends on owner, repo, ref and setup", async () => {
  const one = await baseKey("alice", "a/b", "main", "npm ci");

  assert.match(one, /^base:[0-9a-f]{32}$/);
  assert.equal(one, await baseKey("alice", "a/b", "main", "npm ci"));
  assert.notEqual(one, await baseKey("bob", "a/b", "main", "npm ci"));
  assert.notEqual(one, await baseKey("alice", "a/b", "dev", "npm ci"));
  assert.notEqual(one, await baseKey("alice", "a/b", "main", "npm i"));
});
