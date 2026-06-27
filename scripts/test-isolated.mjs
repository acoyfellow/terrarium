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
// Strip ambient Terrarium lineage/scope env so the suite is hermetic even when
// the tests themselves run inside a Terrarium child (CI delegation, local agent
// runs). Otherwise inherited TERRARIUM_RUN_ID/scopes silently constrain
// effectiveAccess and access-control assertions become environment-dependent.
const env = { ...process.env, TERRARIUM_HOME: home };
for (const key of ["TERRARIUM_RUN_ID", "TERRARIUM_PARENT_RUN_ID", "TERRARIUM_STATUS_SCOPE", "TERRARIUM_READ_SCOPE", "TERRARIUM_DEPTH", "TERRARIUM_MAX_DEPTH", "TERRARIUM_ALLOW_SPAWN", "TERRARIUM_CHILD_BUDGET", "TERRARIUM_EVENT_CHANNEL", "TERRARIUM_MRE_LOG_PATH"]) delete env[key];
try {
  const child = spawn(process.execPath, ["--test", ...tests], {
    cwd: root,
    env,
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
