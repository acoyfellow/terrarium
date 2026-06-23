import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tests = (await readdir(join(root, "test")))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join("test", name));
const home = await mkdtemp(join(tmpdir(), "terrarium-test-home-"));
try {
  const child = spawn(process.execPath, ["--test", ...tests], {
    cwd: root,
    env: { ...process.env, TERRARIUM_HOME: home },
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value, signal) => resolve(value ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
} finally {
  await rm(home, { recursive: true, force: true });
}
