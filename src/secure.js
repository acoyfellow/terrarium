import { execFileSync } from "node:child_process";
import { makeRunId } from "./core.js";
import { createSecureContainer, destroySecureContainer } from "./secure-container.js";
import { SECURE_PROFILE } from "./secure-profile.js";

export { SECURE_PROFILE };

export async function runSecureTask({ task, cwd = process.cwd(), image = SECURE_PROFILE.image, timeoutMs = SECURE_PROFILE.timeoutMs, keepWorkspace = false } = {}) {
  if (typeof task !== "string" || !task.trim()) throw new Error("secure task required");
  const runId = makeRunId().replace(/^ter_/, "secure_");
  const action = /\b(test|tests|test suite)\b/i.test(task) ? "test"
    : /\b(syntax|imports?)\b/i.test(task) ? "syntax"
    : /\b(package|metadata)\b/i.test(task) ? "metadata"
    : /\b(docs?|documentation)\b/i.test(task) ? "docs"
    : /\b(public|schema|redaction)\b/i.test(task) ? "public-schema" : null;
  if (!action) throw new Error("secure-v1 supports test, syntax, metadata, docs, and public-schema validation tasks");
  // Archive-copy source into a disposable no-network container; no host mount.
  const secure = createSecureContainer({ cwd, image });
  const { container, startedAt, sourceRevision } = secure;
  let output = "", exitCode = 1, receipt;
  try {
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
    receipt = { receiptVersion: 1, runId, profile: SECURE_PROFILE, action, taskDigest: await digest(task), sourceRevision, startedAt, finishedAt: new Date().toISOString(), exitCode, verdict: exitCode === 0 ? "completed" : "failed", teardownVerified: false, outputTail: output.slice(-4000) };
  } finally {
    const removed = destroySecureContainer(container);
    if (!removed) throw new Error("secure container survived teardown");
    if (receipt) receipt.teardownVerified = true;
  }
  return receipt;
}

async function digest(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
