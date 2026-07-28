import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MCP_PATH = fileURLToPath(new URL("../src/mcp.js", import.meta.url));
const IMMEDIATELY_EXITING_AGENT = `${process.execPath} -e ""`;

// Drive the MCP spawn handler over stdio with a controlled env. Returns the
// tool-call response text. A dry-run plans without executing (no host
// authority, no cloud call), so it is safe in CI while still exercising the
// cloud-vs-local ROUTING decision that precedes execution.
function mcpCall(name, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.on("error", reject);
    child.on("close", () => {
      const responses = out.split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      const call = responses.find((r) => r.id === 1);
      resolve(call?.result?.content?.[0]?.text ?? JSON.stringify(call));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
    child.stdin.end();
    setTimeout(() => child.kill(), 15000).unref?.();
  });
}

function spawnCall(args, env = {}) {
  return mcpCall("terrarium_spawn", args, env);
}

function batchCall(args, env = {}) {
  return mcpCall("terrarium_spawn_batch", args, env);
}

// Simulated cloud config: TERRARIUM_URL + token present => cloudEnabled() true.
const CLOUD_ENV = {
  TERRARIUM_URL: "https://terrarium.example.invalid",
  TERRARIUM_CONTROL_TOKEN: "test-token-not-real",
  TERRARIUM_ALLOW_LOCAL: "",
};

test("cloud is refused for a filesystem-dependent task when local is NOT allowed", async () => {
  const text = await spawnCall(
    { task: "Read /Users/someone/project and summarize it.", background: true },
    CLOUD_ENV,
  );
  // Cloud path fails closed with the filesystem-dependency refusal.
  assert.match(text, /cloud spawn refused|filesystem/i, text);
});

test("TERRARIUM_ALLOW_LOCAL=1 routes a filesystem-dependent task to the LOCAL backend (no cloud refusal)", async () => {
  const text = await spawnCall(
    // Explicit local cwd => detectFilesystemDependency true => with allowLocal, route local.
    { task: "run a local command", cwd: "/tmp", isolation: "none", background: true, dryRun: true },
    { ...CLOUD_ENV, TERRARIUM_ALLOW_LOCAL: "1" },
  );
  // The whole point of the fix: it must NOT hit the cloud filesystem refusal.
  assert.doesNotMatch(text, /cloud spawn refused/i, text);
});

test("TERRARIUM_ALLOW_LOCAL=1 routes a filesystem-dependent batch to the LOCAL backend", async () => {
  const text = await batchCall(
    {
      jobs: [{ task: "run a local command", cwd: "/tmp", isolation: "none", agent: IMMEDIATELY_EXITING_AGENT }],
      strategy: "all",
    },
    { ...CLOUD_ENV, TERRARIUM_ALLOW_LOCAL: "1" },
  );
  assert.doesNotMatch(text, /cloud batch refused|filesystem-dependent/i, text);
});

test("a NON-filesystem cloud-suitable task still routes to cloud even with allowLocal set", async () => {
  // No local path, no cwd, no read-files intent => not filesystem-dependent =>
  // stays on cloud (the default) even when local is allowed. allowLocal only
  // diverts filesystem-dependent tasks, it does not force everything local.
  const text = await spawnCall(
    { task: "Say the word ACORN and nothing else.", background: true },
    { ...CLOUD_ENV, TERRARIUM_ALLOW_LOCAL: "1" },
  );
  // Cloud is unreachable (invalid host) so this errors on the cloud call — the
  // signal that it CHOSE cloud, not local. It must NOT be a local dry-run plan.
  assert.doesNotMatch(text, /dryRun|plan|isolation/i, text);
});
