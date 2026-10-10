import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function configPath(env = process.env) {
  const home = env.TERRARIUM_HOME ? resolve(env.TERRARIUM_HOME) : join(homedir(), ".terrarium");
  return { home, path: join(home, "config.json") };
}

export async function saveCloudLogin(url, env = process.env) {
  const { home, path } = configPath(env);
  let current = {};
  try { current = JSON.parse(await readFile(path, "utf8")) || {}; } catch { current = {}; }
  await mkdir(home, { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...current, cloudUrl: url, accessLogin: true }, null, 2)}\n`, { mode: 0o600 });
  return path;
}
