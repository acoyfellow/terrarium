#!/usr/bin/env node
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, "a");
  try {
    await fh.write(`${JSON.stringify(value)}\n`);
    await fh.sync().catch(() => {});
  } finally {
    await fh.close();
  }
}

export async function recordCommand({ logPath, command, args = [], cwd = process.cwd() }) {
  if (!logPath) throw new Error("logPath required");
  if (!command) throw new Error("command required");
  const entry = { at: new Date().toISOString(), cwd: resolve(cwd), argv: [command, ...args] };
  await appendJsonl(logPath, entry);
  return await new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", (error) => resolveRun({ ...entry, exitCode: 127, error: error.message }));
    child.on("close", (code, signal) => resolveRun({ ...entry, exitCode: code ?? (signal ? 128 : 0), signal: signal ?? null }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [logPath, command, ...args] = process.argv.slice(2);
  const result = await recordCommand({ logPath, command, args });
  process.exitCode = result.exitCode;
}
