import assert from "node:assert/strict";
import test from "node:test";

import { Option } from "effect";

import { detectProof } from "../src/default-proof.ts";

const empty = { files: [], packageJson: "", makefile: "" };

test("an empty workspace has no default proof", () => {
  assert.equal(Option.isNone(detectProof(empty)), true);
});

test("a package.json with a real test script uses npm test", () => {
  const ws = { ...empty, files: ["package.json"], packageJson: JSON.stringify({ scripts: { test: "node --test" } }) };

  assert.deepEqual(detectProof(ws), Option.some("npm test --silent"));
});

test("the npm init placeholder test script is not a proof", () => {
  const ws = { ...empty, files: ["package.json"], packageJson: JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }) };

  assert.equal(Option.isNone(detectProof(ws)), true);
});

test("malformed package.json falls through to other markers", () => {
  const ws = { files: ["package.json", "Makefile"], packageJson: "{nope", makefile: "build:\n\ttrue\ntest:\n\ttrue\n" };

  assert.deepEqual(detectProof(ws), Option.some("make test"));
});

test("a Makefile without a test target is not a proof", () => {
  assert.equal(Option.isNone(detectProof({ ...empty, files: ["Makefile"], makefile: "build:\n\ttrue\n" })), true);
});

test("language markers map to their test runners", () => {
  assert.deepEqual(detectProof({ ...empty, files: ["Cargo.toml"] }), Option.some("cargo test --quiet"));
  assert.deepEqual(detectProof({ ...empty, files: ["go.mod"] }), Option.some("go test ./..."));
  assert.deepEqual(detectProof({ ...empty, files: ["pyproject.toml"] }), Option.some("python3 -m pytest -q"));
});
