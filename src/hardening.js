import { execFileSync } from "node:child_process";
import { SCENARIO_IDS, runSandboxScenario } from "./sandbox.js";
import { CONTROL_SCENARIO_IDS, CONTROL_SCENARIOS } from "./control-scenarios.js";
import { PROBE_IDS, runParameterizedProbe } from "./parameterized-probes.js";
import { SECURE_PROFILE } from "./secure.js";

export async function verifyHardening({ cwd = process.cwd(), includeClarifications = false } = {}) {
  const revision = gitHead(cwd);
  const results = [];
  for (const id of SCENARIO_IDS) results.push({ id, group: "sandbox", ...(await runSandboxScenario({ scenarioId: id })) });
  for (const id of CONTROL_SCENARIO_IDS) results.push({ id, group: "control", ...(await CONTROL_SCENARIOS[id].detect()) });
  for (const id of PROBE_IDS) {
    if (!includeClarifications && id === "interpreter-proxy-exec") continue;
    results.push({ id, group: "strategist-regression", ...(await runParameterizedProbe(id)) });
  }
  const failures = results.filter((result) => result.verdict !== "contained");
  return { profile: SECURE_PROFILE.id, revision, testedAt: new Date().toISOString(), knownAttacks: results.length, contained: results.length - failures.length, regressions: failures.map(({ id, group, verdict, observed }) => ({ id, group, verdict, observed })), ok: failures.length === 0 };
}

function gitHead(cwd) { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(); } catch { return null; } }
