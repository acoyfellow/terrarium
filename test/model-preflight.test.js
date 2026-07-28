import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fixture({ authenticated }) {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-model-preflight-"));
  const bin = join(dir, "bin");
  const agentDir = join(dir, "agent");
  const home = join(dir, "home");
  const launched = join(dir, "launched");
  mkdirSync(bin, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "opencode.cloudflare.dev" }));
  if (authenticated) {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      "opencode.cloudflare.dev": { type: "oauth", access: "test-access", expires: Date.now() + 60000 },
    }));
  }
  writeFileSync(join(bin, "pi"), "#!/bin/sh\ntouch \"$FAKE_PI_LAUNCH\"\nprintf 'ok\\n'\n", { mode: 0o755 });
  return { dir, agentDir, home, launched, bin };
}

function runCli(f) {
  return spawnSync(process.execPath, [
    join(root, "src", "cli.js"),
    "--json",
    "--agent", "pi -p --no-session",
    "--model", "gpt-5.6-terra",
    "--profile", "minimal",
    "--timeout-ms", "60000",
    "--max-depth", "1",
    "--task", "echo ok",
  ], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      HOME: f.home,
      PI_CODING_AGENT_DIR: f.agentDir,
      PI_PROVIDER: "",
      TERRARIUM_PROVIDER: "",
      OPENCODE_CLOUDFLARE_TOKEN: "",
      OPENCODE_CLOUDFLARE_AUTH_FILE: join(f.dir, "missing-opencode-auth.json"),
      XDG_DATA_HOME: join(f.dir, "xdg"),
      TERRARIUM_HOME: f.home,
      TERRARIUM_RUN_ID: "",
      TERRARIUM_PARENT_RUN_ID: "",
      TERRARIUM_DEPTH: "",
      TERRARIUM_MAX_DEPTH: "",
      TERRARIUM_ALLOW_SPAWN: "",
      TERRARIUM_CHILD_BUDGET: "",
      TERRARIUM_STATUS_SCOPE: "",
      TERRARIUM_READ_SCOPE: "",
      TERRARIUM_MRE_LOG_PATH: "",
      FAKE_PI_LAUNCH: f.launched,
    },
    encoding: "utf8",
    timeout: 60000,
  });
}

test("CLI uses the configured Pi provider for gpt-5.6-terra and refuses a missing credential before launch", () => {
  const authenticated = fixture({ authenticated: true });
  const unauthenticated = fixture({ authenticated: false });
  try {
    const success = runCli(authenticated);
    assert.equal(success.status, 0, success.stderr);
    const result = JSON.parse(success.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.provider, "opencode.cloudflare.dev");
    assert.equal(result.model, "gpt-5.6-terra");
    assert.equal(result.agent, "pi -p --no-session --provider opencode.cloudflare.dev --model gpt-5.6-terra");
    assert.equal(readFileSync(authenticated.launched, "utf8"), "");

    const failure = runCli(unauthenticated);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /model preflight failed: resolved provider "opencode\.cloudflare\.dev" and model "gpt-5\.6-terra" have no usable credential/);
    assert.match(failure.stderr, /pi login opencode\.cloudflare\.dev/);
    assert.equal(existsSync(unauthenticated.launched), false);
  } finally {
    rmSync(authenticated.dir, { recursive: true, force: true });
    rmSync(unauthenticated.dir, { recursive: true, force: true });
  }
});
