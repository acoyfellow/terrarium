#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

async function walk(dir, root = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path, root));
    else if (entry.isFile()) out.push(relative(root, path));
  }
  return out.sort();
}

export async function hashFiles(root) {
  if (!root || !existsSync(root)) throw new Error("root directory required");
  const files = await walk(root);
  const result = {};
  for (const file of files) {
    const path = join(root, file);
    const data = await readFile(path);
    const st = await stat(path);
    result[file] = {
      sha256: createHash("sha256").update(data).digest("hex"),
      size: data.length,
      mtimeMs: Math.round(st.mtimeMs),
    };
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] || process.cwd();
  console.log(JSON.stringify(await hashFiles(root), null, 2));
}
