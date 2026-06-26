import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecureContainer, destroySecureContainer } from "./secure-container.js";
import { SECURE_PROFILE } from "./secure-profile.js";

const SERVER_PATH = fileURLToPath(new URL("./secure-mcp.js", import.meta.url));

function killGroup(child, signal) { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } }

function auditPiOutput(output) {
  const calls = [], finalTexts = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.details?.mode === "call" && typeof value.details?.server === "string" && typeof value.details?.tool === "string") calls.push({ server: value.details.server, tool: value.details.tool, isError: Boolean(value.isError) });
      if (value.role === "assistant" && Array.isArray(value.content)) for (const item of value.content) if (item.type === "text") finalTexts.push(item.text);
      for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
    };
    visit(event);
  }
  const unique = calls.filter((call, i) => !calls.slice(0, i).some((x) => x.server === call.server && x.tool === call.tool && x.isError === call.isError));
  const forbidden = unique.filter((call) => call.server !== "terrarium-secure" || !["search", "execute", "finish"].includes(call.tool));
  if (forbidden.length) throw new Error(`agent invoked a tool outside Terrarium secure MCP: ${forbidden.map((c) => `${c.server || "builtin"}/${c.tool}`).join(", ")}`);
  return { calls: unique, finalText: finalTexts.at(-1)?.slice(0, 1000) || "" };
}

const SAFE_PI_ENV = ["PATH", "HOME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "TERM", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"];

export function secureAgentEnv(source = process.env) {
  return Object.fromEntries(SAFE_PI_ENV.filter((key) => typeof source[key] === "string").map((key) => [key, source[key]]));
}

function runPi(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], detached: true, env: secureAgentEnv() });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child, "SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer); killGroup(child, "SIGTERM"); setTimeout(() => killGroup(child, "SIGKILL"), 250).unref();
      if (!timedOut && code === 0) resolve({ stdout, stderr, exitCode: code });
      else reject(new Error(timedOut ? "secure agent timed out" : stderr || `Pi exited ${code}`));
    });
  });
}

export async function runSecureAgent({ task, cwd = process.cwd(), model, timeoutMs = 300000 } = {}) {
  if (typeof task !== "string" || !task.trim()) throw new Error("secure agent task required");
  if (!model) throw new Error("secure agent model required");
  const temp = await mkdtemp(join(tmpdir(), "terrarium-secure-agent-"));
  const receiptPath = join(temp, "finish.json");
  const configPath = join(temp, "mcp.json");
  const mcpExtension = process.env.PI_MCP_EXTENSION || join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "index.ts");
  if (!existsSync(mcpExtension)) throw new Error("Pi MCP adapter not found; set PI_MCP_EXTENSION");
  const secure = createSecureContainer({ cwd });
  const startedAt = new Date().toISOString();
  let result;
  try {
    await writeFile(configPath, JSON.stringify({ mcpServers: { "terrarium-secure": { command: process.execPath, args: [SERVER_PATH], env: { TERRARIUM_SECURE_CONTAINER: secure.container, TERRARIUM_SECURE_RECEIPT_PATH: receiptPath }, directTools: true } } }, null, 2));
    const prompt = `Complete exactly this coding task: ${task}\n\nYou have no host shell or host filesystem tools. Use only the Terrarium secure MCP. Use search/execute to inspect and edit the secure workspace. Run tests. Call finish exactly once when the task is complete. Do not claim success without finish returning tests.passed=true.`;
    // Keep provider extensions enabled (private/custom providers may live there), but
    // disable every built-in tool and positively allow only this run's MCP surface.
    const pi = await runPi(["-p", "--mode", "json", "--no-session", "--model", model, "--no-builtin-tools", "--tools", "mcp", "--no-skills", "--no-context-files", "--mcp-config", configPath, prompt], { timeoutMs });
    if (!existsSync(receiptPath)) throw new Error("agent exited without calling finish");
    const finish = JSON.parse(await readFile(receiptPath, "utf8"));
    const audit = auditPiOutput(pi.stdout);
    if (!audit.calls.some((call) => call.server === "terrarium-secure" && call.tool === "finish")) throw new Error("finish receipt exists without an audited finish call");
    result = { receiptVersion: 1, profile: SECURE_PROFILE.id, sourceRevision: secure.sourceRevision, startedAt, finishedAt: new Date().toISOString(), taskDigest: await digest(task), agentExitCode: pi.exitCode, tests: finish.tests, diff: finish.diff, toolAudit: audit.calls, agentSummary: audit.finalText, teardownVerified: false };
  } finally {
    const removed = destroySecureContainer(secure.container);
    await rm(temp, { recursive: true, force: true });
    if (!removed) throw new Error("secure agent container survived teardown");
    if (result) result.teardownVerified = true;
  }
  return result;
}

async function digest(text) { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
