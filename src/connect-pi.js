import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_NAME = "terrarium";

function piAgentDir(env) {
  return env.PI_AGENT_DIR ? resolve(env.PI_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

function backupPath(env, name) {
  const dir = join(env.TERRARIUM_HOME ? resolve(env.TERRARIUM_HOME) : join(homedir(), ".terrarium"), "backups");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${name}.bak-${Date.now()}`);
}

function readJsonFile(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) || {};
}

export function writeMcpServer(url, env = process.env) {
  const path = join(piAgentDir(env), "mcp.json");
  const config = readJsonFile(path);
  const servers = config.mcpServers ?? {};
  servers[SERVER_NAME] = {
    command: process.execPath,
    args: [join(repoRoot, "src", "mcp.js")],
    env: { TERRARIUM_URL: url, TERRARIUM_ACCESS_LOGIN: "1" },
  };
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) writeFileSync(backupPath(env, "mcp.json"), readFileSync(path));
  writeFileSync(path, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`);
  return path;
}

const EXTENSION_LINK = "terrarium";
const LEGACY_EXTENSION_FILE = "terrarium-autocontinue.ts";

function clearExtensionPath(env, path, name) {
  let existing = null;
  try { existing = lstatSync(path); } catch { existing = null; }
  if (!existing) return;
  if (existing.isSymbolicLink()) unlinkSync(path);
  else renameSync(path, backupPath(env, name));
}

export function linkCallbackExtension(env = process.env) {
  const source = join(repoRoot, "pi-extension");
  const dir = join(piAgentDir(env), "extensions");
  const target = join(dir, EXTENSION_LINK);
  mkdirSync(dir, { recursive: true });
  clearExtensionPath(env, join(dir, LEGACY_EXTENSION_FILE), LEGACY_EXTENSION_FILE);
  clearExtensionPath(env, target, EXTENSION_LINK);
  symlinkSync(source, target);
  return target;
}

export function connectPi(url, env = process.env) {
  return { mcpConfig: writeMcpServer(url, env), extension: linkCallbackExtension(env) };
}
