import { execFileSync, spawnSync } from "node:child_process";
import { SECURE_PROFILE } from "./secure-profile.js";

export function dockerAvailable() {
  try { execFileSync("docker", ["version"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; }
}

export function createSecureContainer({ cwd = process.cwd(), image = SECURE_PROFILE.image } = {}) {
  if (!dockerAvailable()) throw new Error("secure execution requires Docker");
  const container = `terrarium-secure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const args = ["run", "-d", "--name", container, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", String(SECURE_PROFILE.pids), "--memory", SECURE_PROFILE.memory, "--cpus", SECURE_PROFILE.cpus, "--user", SECURE_PROFILE.user, "--tmpfs", `/workspace:${SECURE_PROFILE.workspace},uid=65534,gid=65534`, "--tmpfs", `/tmp:${SECURE_PROFILE.tmp}`, "--workdir", "/workspace", image, "sh", "-lc", "sleep 3600"];
  execFileSync("docker", args, { stdio: "ignore" });
  try {
    copyWorkspace(container, cwd);
  } catch (error) { try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch {} throw error; }
  return { container, cwd, sourceRevision: gitHead(cwd), startedAt: new Date().toISOString() };
}

function copyWorkspace(container, cwd) {
  const excludes = [".git", "node_modules", "dist", ".env", ".env.*", ".npmrc", ".pypirc", ".netrc", ".aws", ".config/gcloud", ".docker/config.json", ".ssh", "._*"];
  const archive = spawnSync("tar", [...excludes.flatMap((path) => ["--exclude", path]), "-C", cwd, "-cf", "-", "."], { encoding: null, maxBuffer: 256 * 1024 * 1024, timeout: 60000, env: { PATH: process.env.PATH ?? "", COPYFILE_DISABLE: "1" } });
  if (archive.status !== 0 || !archive.stdout) throw new Error(String(archive.stderr || "workspace archive failed").trim());
  const extract = spawnSync("docker", ["exec", "-i", "--user", "65534:65534", container, "tar", "-xf", "-", "-C", "/workspace", "--no-same-owner", "--no-same-permissions"], { input: archive.stdout, encoding: null, maxBuffer: 1024 * 1024, timeout: 60000 });
  if (extract.status !== 0) throw new Error(String(extract.stderr || "workspace extraction failed").trim());
}

export function destroySecureContainer(container) {
  try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch {}
  try { execFileSync("docker", ["inspect", container], { stdio: "ignore" }); return false; } catch { return true; }
}

function gitHead(cwd) { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch { return null; } }
