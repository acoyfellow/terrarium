import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorktreeSource } from "../src/cloudbox-client.js";
import { spawnCapture } from "../src/core.js";

async function git(cwd, ...args) {
  const r = await spawnCapture("git", args, { cwd, timeoutMs: 10000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), "wt-src-"));
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t.dev");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  await writeFile(join(dir, "add.js"), "export const add = (a, b) => a - b;\n");
  await writeFile(join(dir, ".gitignore"), "secret.env\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "base");
  return dir;
}

test("clean tree returns null (no worktreeSource)", async () => {
  const dir = await makeRepo();
  try {
    assert.equal(await captureWorktreeSource(dir), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("non-git cwd returns null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wt-nogit-"));
  try {
    assert.equal(await captureWorktreeSource(dir), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SENTINEL: uncommitted tracked edit + untracked file survive capture->apply onto a fresh clone", async () => {
  const dir = await makeRepo();
  const base = (await git(dir, "rev-parse", "HEAD")).trim();
  try {
    await writeFile(join(dir, "add.js"), "export const add = (a, b) => a + b;\n");
    await writeFile(join(dir, "SENTINEL.txt"), "uncommitted-only-42\n");

    const src = await captureWorktreeSource(dir);
    assert.ok(src, "expected a worktreeSource for a dirty tree");
    assert.equal(src.kind, "patch");
    assert.equal(src.base, base);
    assert.equal(src.includeUntracked, true);
    assert.ok(src.files >= 2, `expected >=2 files, got ${src.files}`);
    assert.match(src.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!src.patch.includes("secret.env"));

    const clone = await mkdtemp(join(tmpdir(), "wt-clone-"));
    await git(clone, "clone", "-q", dir, "repo");
    const ws = join(clone, "repo");
    await git(ws, "checkout", "-q", base);
    const patchFile = join(clone, "wt.patch");
    await writeFile(patchFile, src.patch);
    const applied = await spawnCapture("git", ["apply", "--3way", "--whitespace=nowarn", patchFile], { cwd: ws, timeoutMs: 10000 });
    assert.equal(applied.code, 0, `git apply failed: ${applied.stderr}`);

    assert.equal((await readFile(join(ws, "SENTINEL.txt"), "utf8")).trim(), "uncommitted-only-42");
    assert.match(await readFile(join(ws, "add.js"), "utf8"), /a \+ b/);
    await rm(clone, { recursive: true, force: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("gitignored secret excluded by default; included only with includeIgnored", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, "secret.env"), "API_TOKEN=supersecret\n");
    await writeFile(join(dir, "note.txt"), "hello\n");
    const def = await captureWorktreeSource(dir);
    assert.ok(def, "tree is dirty (note.txt)");
    assert.ok(!def.patch.includes("supersecret"), "default capture must exclude gitignored secret");

    const withIgnored = await captureWorktreeSource(dir, { includeIgnored: true });
    assert.ok(withIgnored.patch.includes("supersecret"), "includeIgnored must include the ignored file");
    assert.equal(withIgnored.includeIgnored, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
