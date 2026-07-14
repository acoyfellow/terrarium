// Test-home isolation guard (belt-and-suspenders).
//
// src/core.js resolves HOME once at module load from process.env.TERRARIUM_HOME,
// falling back to ~/.terrarium. The official runner (scripts/test-isolated.mjs)
// sets an isolated temp TERRARIUM_HOME for the whole suite. But a BARE run of a
// single file (e.g. `node --test test/basic.test.js`) bypasses that wrapper and
// would pollute the real operator home with run/journal fixtures.
//
// Preloaded via `--import ./test/setup-home.mjs`, this guard sets TERRARIUM_HOME
// to a fresh temp dir BEFORE any src/core.js import, but ONLY when it is not
// already set — so it is a strict no-op under the official runner and never
// weakens that isolation. The temp dir is best-effort cleaned on process exit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.TERRARIUM_HOME) {
  const home = mkdtempSync(join(tmpdir(), "terrarium-test-home-"));
  process.env.TERRARIUM_HOME = home;
  const cleanup = () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } };
  process.once("exit", cleanup);
}
