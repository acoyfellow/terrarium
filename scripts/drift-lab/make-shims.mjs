#!/usr/bin/env node
// Generate a PATH-shim directory. Each shim logs argv (via record-commands.mjs)
// before exec'ing the REAL binary. Put this dir first on PATH for a child, set
// DRIFT_CMD_LOG, and every shell command the child runs is recorded with trusted
// argv — not the child's self-report.
//
// Usage: node make-shims.mjs <shimDir> [cmd1 cmd2 ...]
// Defaults to a common set of read/inspect/exec commands used to drift.
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const recorder = resolve(here, "record-commands.mjs");

const DEFAULT_CMDS = [
  "cat", "less", "more", "head", "tail", "od", "hexdump", "strings",
  "grep", "egrep", "rg", "ag", "find", "ls", "tree", "wc", "stat", "file",
  "make", "sed", "awk", "cut", "sort", "uniq", "diff", "curl", "wget",
  "git", "env", "printenv", "xxd", "nl",
];

function realPath(cmd, shimDir) {
  // Resolve the real binary, excluding the shim dir from PATH.
  const path = (process.env.PATH || "").split(":").filter((p) => p && resolve(p) !== resolve(shimDir)).join(":");
  try {
    return execFileSync("bash", ["-lc", `PATH="${path}" command -v ${cmd} || true`], { encoding: "utf8" }).trim();
  } catch { return ""; }
}

const shimDir = resolve(process.argv[2] || "/tmp/drift-shims");
const cmds = process.argv.slice(3).length ? process.argv.slice(3) : DEFAULT_CMDS;

await mkdir(shimDir, { recursive: true });
let made = 0;
for (const cmd of cmds) {
  const real = realPath(cmd, shimDir);
  if (!real) continue; // command not installed; skip
  const shim = `#!/bin/bash
node "${recorder}" "\${DRIFT_CMD_LOG:?DRIFT_CMD_LOG unset}" "${real}" "$@"
`;
  const p = join(shimDir, cmd);
  await writeFile(p, shim);
  await chmod(p, 0o755);
  made++;
}
console.log(JSON.stringify({ shimDir, recorder, shimmed: made, of: cmds.length }));
