import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorized } from "../src/controller-auth.js";

test("controller bearer authentication is fail closed", () => {
  assert.equal(isAuthorized(new Request("https://x"), undefined), false);
  assert.equal(isAuthorized(new Request("https://x", { headers: { authorization: "Bearer wrong" } }), "right"), false);
  assert.equal(isAuthorized(new Request("https://x", { headers: { authorization: "Bearer right" } }), "right"), true);
});
