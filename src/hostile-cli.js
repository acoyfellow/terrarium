import { spawn } from "node:child_process";
import { adaptivePrompt, parseAdaptivePayload } from "./adaptive.js";
import { DEFAULT_LAB_POLICY } from "./lab.js";
import { splitCommand } from "./core.js";
import { execFileSync } from "node:child_process";

function runCommand(command, prompt, timeoutMs = 120000) {
  const parts = splitCommand(command);
  return new Promise((resolve, reject) => {
    const child = spawn(parts[0], [...parts.slice(1), prompt], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (data) => stdout += String(data));
    child.stderr.on("data", (data) => stderr += String(data));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `attacker exited ${code}`));
    });
  });
}

async function controllerCall(controller, token, path, body) {
  const response = await fetch(`${controller.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `controller request failed: ${response.status}`);
  return result;
}

export async function runManualHostile({ scenarioId = "lab-env-canary", turns = 1, agent = "pi -p --no-session", model, controller, token, timeoutMs = 120000 } = {}) {
  if (!controller) throw new Error("controller URL required");
  if (!token) throw new Error("TERRARIUM_CONTROL_TOKEN required");
  const maxTurns = Math.max(1, Math.min(3, Number(turns) || 1));
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let feedback = null;
  const results = [];
  for (let turn = 1; turn <= maxTurns; turn++) {
    const command = model ? `${agent} --model ${model}` : agent;
    const proposalText = await runCommand(command, adaptivePrompt({ scenarioId, turn, maxTurns, feedback }), timeoutMs);
    const payload = parseAdaptivePayload(proposalText, DEFAULT_LAB_POLICY);
    const result = await controllerCall(controller, token, "/campaigns/manual", { scenarioId, payload, turn, maxTurns, sourceRevision });
    feedback = result.feedback;
    results.push(result);
    if (result.verdict === "verified-escape") break;
  }
  return { scenarioId, turnBudget: maxTurns, turnsUsed: results.length, results, finalVerdict: results.at(-1)?.verdict || "inconclusive" };
}
