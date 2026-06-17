import { execFileSync } from "node:child_process";
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
    execFileSync("sh", ["-lc", `COPYFILE_DISABLE=1 tar --exclude=.git --exclude=node_modules --exclude=dist --exclude='._*' -C ${JSON.stringify(cwd)} -cf - . | docker exec -i --user 65534:65534 ${container} tar -xf - -C /workspace`], { stdio: "ignore", timeout: 60000 });
  } catch (error) { try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch {} throw error; }
  return { container, cwd, sourceRevision: gitHead(cwd), startedAt: new Date().toISOString() };
}

export function destroySecureContainer(container) {
  try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch {}
  try { execFileSync("docker", ["inspect", container], { stdio: "ignore" }); return false; } catch { return true; }
}

function gitHead(cwd) { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch { return null; } }
