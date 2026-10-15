import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { Option, Schema } from "effect";

import { DIFF_LIMIT, RepoSpec, archiveUrl, clippedDiff, sessionBranch, unpackCommand } from "../src/repo.ts";

const decode = Schema.decodeUnknownOption(RepoSpec);

test("a GitHub owner/name maps to its codeload archive", () => {
  assert.deepEqual(archiveUrl({ github: "acoyfellow/terrarium", ref: "main" }), Option.some("https://codeload.github.com/acoyfellow/terrarium/tar.gz/main"));
  assert.deepEqual(archiveUrl({ github: "a/b" }), Option.some("https://codeload.github.com/a/b/tar.gz/HEAD"));
});

test("specs that could leave the archive host are refused", () => {
  assert.equal(Option.isNone(decode({ github: "a/b/c" })), true);
  assert.equal(Option.isNone(decode({ github: "evil.com/../x" })), true);
  assert.equal(Option.isNone(decode({ github: "a/b", ref: "x y" })), true);
  assert.equal(Option.isNone(archiveUrl({ github: "a/b", ref: "../../x" })), true);
});

test("the session branch is named after the run", () => {
  assert.equal(sessionBranch("ter_abc123_0123456789ab"), "terrarium/ter_abc123_0123456789ab");
});

test("the unpack command makes a base commit and a session branch", () => {
  const command = unpackCommand("ter_abc123_0123456789ab");

  assert.match(command, /git init -q -b base/);
  assert.match(command, /git checkout -q -b terrarium\/ter_abc123_0123456789ab/);
  assert.equal(spawnSync("sh", ["-n", "-c", command]).status, 0);
});

test("long diffs are clipped and flagged", () => {
  assert.deepEqual(clippedDiff("abc"), { diff: "abc", diffTruncated: false });
  assert.equal(clippedDiff("x".repeat(DIFF_LIMIT + 5)).diffTruncated, true);
});
