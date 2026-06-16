import { execFileSync } from "node:child_process";
import { makeRunId } from "./core.js";

export const SECURE_PROFILE = Object.freeze({
  id: "secure-v1",
  image: "node:22-alpine",
  network: "none",
  rootFilesystem: "read-only",
  user: "65534:65534",
  capabilities: "drop-all",
  noNewPrivileges: true,
  workspace: "rw,noexec,nosuid,size=64m",
  tmp: "rw,noexec,nosuid,size=16m",
  pids: 32,
  memory: "512m",
  cpus: "1",
  timeoutMs: 300000,
  maxOutputBytes: 65536,
  childBudget: 1,
  maxDepth: 2,
});

function dockerAvailable() {
  try { execFileSync("docker", ["version"], { stdio: "ignore", timeout: 5000 }); return true; } catch { return false; }
}

export async function runSecureTask({ task, cwd = process.cwd(), image = SECURE_PROFILE.image, timeoutMs = SECURE_PROFILE.timeoutMs, keepWorkspace = false } = {}) {
  if (typeof task !== "string" || !task.trim()) throw new Error("secure task required");
  if (!dockerAvailable()) throw new Error("terra secure requires Docker");
  const runId = makeRunId().replace(/^ter_/, "secure_");
  const action = /\b(test|tests|test suite)\b/i.test(task) ? "test"
    : /\b(syntax|imports?)\b/i.test(task) ? "syntax"
    : /\b(package|metadata)\b/i.test(task) ? "metadata"
    : /\b(docs?|documentation)\b/i.test(task) ? "docs"
    : /\b(public|schema|redaction)\b/i.test(task) ? "public-schema" : null;
  if (!action) throw new Error("secure-v1 supports test, syntax, metadata, docs, and public-schema validation tasks");
  // Use Docker's archive copy rather than a host bind mount. The agent sees only
  // its disposable workspace; no host repo, Docker socket, or host credentials.
  const container = `terrarium-secure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const args = ["run", "-d", "--name", container, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", String(SECURE_PROFILE.pids), "--memory", SECURE_PROFILE.memory, "--cpus", SECURE_PROFILE.cpus, "--user", SECURE_PROFILE.user, "--tmpfs", `/workspace:${SECURE_PROFILE.workspace},uid=65534,gid=65534`, "--tmpfs", `/tmp:${SECURE_PROFILE.tmp}`, "--workdir", "/workspace", image, "sh", "-lc", "sleep 3600"];
  execFileSync("docker", args, { stdio: "ignore" });
  let output = "", exitCode = 1, receipt;
  try {
    // Copy source through tar stream to avoid mounting host paths.
    execFileSync("sh", ["-lc", `COPYFILE_DISABLE=1 tar --exclude=.git --exclude=node_modules --exclude=dist --exclude='._*' -C ${JSON.stringify(cwd)} -cf - . | docker exec -i --user 65534:65534 ${container} tar -xf - -C /workspace`], { stdio: "ignore", timeout: 60000 });
    const commands = {
      test: "node scripts/secure-test.mjs",
      syntax: "find src scripts -name '*.js' -o -name '*.mjs' | xargs -n1 node --check",
      metadata: "node -e \"const p=require('./package.json'); if(!p.name||!p.version||!p.license) process.exit(1); console.log(p.name,p.version,p.license)\"",
      docs: "test -s README.md && test -s docs/SECURE_V1.md && grep -q 'Non-guarantees' docs/SECURE_V1.md",
      "public-schema": "node --test test/public-ledger.test.js test/trace-events.test.js",
    };
    const script = `echo ${JSON.stringify(task)} > /tmp/terrarium-task.txt; ${commands[action]}`; 
    try { output = execFileSync("docker", ["exec", "--user", SECURE_PROFILE.user, container, "sh", "-lc", script], { encoding: "utf8", timeout: timeoutMs, maxBuffer: SECURE_PROFILE.maxOutputBytes }); exitCode = 0; }
    catch (error) { output = String(error.stdout || error.stderr || error.message).slice(-SECURE_PROFILE.maxOutputBytes); exitCode = error.status ?? 1; }
    receipt = { receiptVersion: 1, runId, profile: SECURE_PROFILE, action, taskDigest: await digest(task), sourceRevision: gitHead(cwd), startedAt, finishedAt: new Date().toISOString(), exitCode, verdict: exitCode === 0 ? "completed" : "failed", teardownVerified: false, outputTail: output.slice(-4000) };
  } finally {
    try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch {}
    const alive = (() => { try { execFileSync("docker", ["inspect", container], { stdio: "ignore" }); return true; } catch { return false; } })();
    if (alive) throw new Error("secure container survived teardown");
    if (receipt) receipt.teardownVerified = true;
  }
  return receipt;
}

async function digest(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function gitHead(cwd) { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch { return null; } }
