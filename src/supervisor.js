#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";
import { superviseTerrariumBackground } from "./core.js";

const specPath = process.argv[2];
if (!specPath) throw new Error("missing background spec path");

const spec = JSON.parse(await readFile(specPath, "utf8"));
try {
  await superviseTerrariumBackground(spec);
} catch (error) {
  // Detached supervisors have no stderr. Preserve a bounded diagnostic in the
  // existing run log without exposing process environment or private metadata.
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await appendFile(spec.run.logPath, `\nsupervisor error: ${message.slice(0, 1000)}\n`).catch(() => {});
  process.exitCode = 1;
}
