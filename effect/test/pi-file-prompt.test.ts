import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piChildArgs } from "../src/pi-child.ts";

const baseArgs = ["-p", "--no-session", "--no-extensions", "--model", "terrarium-test-missing/none"];

const longPrompt = "Reply with OK and nothing else. ".repeat(100);

const piOnPath = spawnSync("pi", ["--version"]).error === undefined;

test("piChildArgs appends @path and never places prompt text in argv", () => {
  const args = piChildArgs(baseArgs, "/tmp/prompt.txt");
  assert.deepEqual(args, [...baseArgs, "@/tmp/prompt.txt"]);
  assert.ok(args.every((arg) => !arg.includes("Reply with OK")));
  assert.ok(args.every((arg) => arg.length < 1000));
});

test("B5.0 real pi given a >2000 char prompt as @file is not SIGKILLed", { skip: piOnPath ? false : "pi is not on PATH" }, () => {
  assert.ok(longPrompt.length > 2000);
  const promptPath = join(mkdtempSync(join(tmpdir(), "pi-prompt-")), "prompt.txt");
  writeFileSync(promptPath, longPrompt);
  const result = spawnSync("pi", [...piChildArgs(baseArgs, promptPath)], { encoding: "utf8", timeout: 60_000 });
  assert.notEqual(result.signal, "SIGKILL", `pi was SIGKILLed: ${result.stderr}`);
  assert.equal(result.signal, null);
});
