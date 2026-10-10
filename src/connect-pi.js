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

export function linkCallbackExtension(env = process.env) {
  const source = join(repoRoot, "pi-extension", "terrarium-autocontinue.ts");
  const dir = join(piAgentDir(env), "extensions");
  const target = join(dir, "terrarium-autocontinue.ts");
  mkdirSync(dir, { recursive: true });
  let existing = null;
  try { existing = lstatSync(target); } catch { existing = null; }
  if (existing?.isSymbolicLink()) unlinkSync(target);
  else if (existing) renameSync(target, backupPath(env, "terrarium-autocontinue.ts"));
  symlinkSync(source, target);
  return target;
}

export function connectPi(url, env = process.env) {
  return { mcpConfig: writeMcpServer(url, env), extension: linkCallbackExtension(env) };
}
