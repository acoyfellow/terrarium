import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { containerEnv } from "../src/container-env.ts";
import type { BoxCalls } from "../src/container-env.ts";

const localBox = (root: string): BoxCalls => ({
  exec: (command, options) => {
    const result = spawnSync("sh", ["-c", command.replaceAll("/workspace", root)], { cwd: options.cwd.replace("/workspace", root), encoding: "utf8", env: { ...process.env, ...options.env } });

    return Promise.resolve({ exitCode: result.status ?? 1, stdout: result.stdout.replaceAll(root, "/workspace"), stderr: result.stderr });
  },
  readBase64: (path) => {
    const local = path.replace("/workspace", root);

    return Promise.resolve(existsSync(local) ? readFileSync(local).toString("base64") : null);
  },
  writeText: (path, content) => Promise.resolve(writeFileSync(path.replace("/workspace", root), content)),
});

const gnu = !spawnSync("uname").stdout.toString().includes("Darwin");

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "terrarium-env-"));

  return { root, env: containerEnv(localBox(root)) };
};

test("paths resolve under /workspace", async () => {
  const { env } = fresh();

  assert.deepEqual(await env.absolutePath("a/../b.txt", BACKGROUND_CONTEXT), { ok: true, value: "/workspace/b.txt" });
});

test("write then read a text file through the box", async () => {
  const { root, env } = fresh();
  await env.writeFile("notes/x.txt", "hello box", BACKGROUND_CONTEXT);

  assert.equal(readFileSync(join(root, "notes/x.txt"), "utf8"), "hello box");
  assert.deepEqual(await env.readTextFile("notes/x.txt", BACKGROUND_CONTEXT), { ok: true, value: "hello box" });
});

test("a missing file is not_found", async () => {
  const { env } = fresh();
  const result = await env.readTextFile("nope.txt", BACKGROUND_CONTEXT);

  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.error.code, "not_found");
});

test("exec runs in the box and streams output", async () => {
  const { env } = fresh();
  const seen: Array<string> = [];
  const result = await env.exec("echo out; echo err 1>&2; exit 3", { onOutput: (text) => void seen.push(text.trim()) }, BACKGROUND_CONTEXT);

  assert.deepEqual(result, { ok: true, value: { exitCode: 3 } });
  assert.deepEqual(seen, ["out", "err"]);
});

test("binary reader returns info, bytes and a line scan", { skip: gnu ? false : "needs GNU stat; the box is Linux" }, async () => {
  const { env } = fresh();
  await env.writeFile("l.txt", "one\ntwo\nthree\n", BACKGROUND_CONTEXT);
  const opened = await env.openBinaryReader("l.txt", undefined, BACKGROUND_CONTEXT);

  assert.equal(opened.ok, true);

  const reader = opened.ok ? opened.value : null;
  const info = await reader?.info(BACKGROUND_CONTEXT);
  const bytes = await reader?.read(0, 3, BACKGROUND_CONTEXT);
  const scan = await reader?.scanLines({ startLine: 1, endLine: 2 }, BACKGROUND_CONTEXT);

  assert.equal(info?.ok, true);
  assert.equal(bytes?.ok && new TextDecoder().decode(bytes.value), "one");
  assert.equal(scan?.ok && scan.value.newlines, 3);
});

test("listDir lists entries with kinds", { skip: gnu ? false : "needs GNU find; the box is Linux" }, async () => {
  const { env } = fresh();
  await env.writeFile("d/a.txt", "a", BACKGROUND_CONTEXT);
  const listed = await env.listDir("d", BACKGROUND_CONTEXT);

  assert.deepEqual(listed.ok ? listed.value.map((entry) => [entry.name, entry.kind]) : [], [["a.txt", "file"]]);
});
