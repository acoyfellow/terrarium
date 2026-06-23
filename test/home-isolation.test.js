import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("TERRARIUM_HOME isolates run, group, and callback state", () => {
  const home = mkdtempSync(join(tmpdir(), "terrarium-home-override-"));
  try {
    const core = pathToFileURL(join(process.cwd(), "src/core.js")).href;
    const router = pathToFileURL(join(process.cwd(), "src/router.js")).href;
    const groups = pathToFileURL(join(process.cwd(), "src/groups.js")).href;
    const script = `
      const c=await import(${JSON.stringify(core)});
      const r=await import(${JSON.stringify(router)});
      const g=await import(${JSON.stringify(groups)});
      console.log(JSON.stringify({home:c.HOME,logs:c.LOG_DIR,router:r.ROUTER_DIR,groups:g.GROUP_DIR}));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, TERRARIUM_HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const paths = JSON.parse(result.stdout.trim());
    assert.equal(paths.home, home);
    for (const path of [paths.logs, paths.router, paths.groups]) assert.equal(path.startsWith(`${home}/`), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
