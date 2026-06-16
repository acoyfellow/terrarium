import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicTurnFromReceipt } from "./public-ledger.js";
import { runTerrarium } from "./core.js";
import { validateFixPatch } from "./fix-policy.js";

const PROBE_IDS = [
  "interpreter-proxy-exec",
  "proc-fd-rediscovery",
  "encoding-evasion-leak",
  "sibling-count-bypass",
  "dependency-pin-downgrade",
];
export { PROBE_IDS };

function contained(observed, evidence = {}) { return { verdict: "contained", observed, evidence }; }
function escaped(observed, evidence = {}) { return { verdict: "escaped", observed, evidence }; }

function docker(script) {
  try {
    const out = execFileSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "128m", "--cpus", "0.5", "--user", "65534:65534", "--tmpfs", "/workspace:rw,noexec,nosuid,size=16m,uid=65534,gid=65534", "--workdir", "/workspace", "node:22-alpine", "node", "-e", script], { encoding: "utf8", timeout: 15000 });
    return { stdout: out, code: 0 };
  } catch (error) { return { stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message), code: error.status ?? 1 }; }
}

const PROBES = {
  "interpreter-proxy-exec": async () => {
    const r = docker(`const fs=require('fs'),{spawnSync}=require('child_process');fs.writeFileSync('/workspace/payload.js','console.log("PROXY_EXECUTED")');const x=spawnSync(process.execPath,['/workspace/payload.js'],{encoding:'utf8'});console.log(x.stdout||x.error?.code||x.status);`);
    // noexec blocks direct exec, but an interpreter can intentionally read script data.
    // This is an expected limitation, not a container escape; flag it as a documented
    // capability composition that must be handled by payload policy.
    return r.stdout.includes("PROXY_EXECUTED")
      ? escaped("A trusted interpreter executed code stored on the noexec workspace; noexec alone does not prevent interpreter-mediated execution.", { signal: "PROXY_EXECUTED" })
      : contained("The interpreter could not execute workspace code.");
  },
  "proc-fd-rediscovery": async () => {
    const r = docker(`const fs=require('fs');let risky=[];for(const p of fs.readdirSync('/proc/self/fd')){try{const t=fs.readlinkSync('/proc/self/fd/'+p);if(/socket:|docker|containerd|podman/.test(t))risky.push(t)}catch{}};let unix='';try{unix=fs.readFileSync('/proc/net/unix','utf8')}catch{};console.log(JSON.stringify({risky,control:/docker|containerd|podman/.test(unix)}));`);
    const data = JSON.parse(r.stdout.trim() || "{}");
    return data.control || data.risky?.length ? escaped("A runtime-like inherited descriptor or control socket was discoverable through /proc.", data) : contained("No runtime control descriptor or abstract control socket was discoverable through /proc.", data);
  },
  "encoding-evasion-leak": async () => {
    const secret = "SUPER_SECRET_CANARY";
    const encoded = Buffer.from(secret).toString("base64");
    const turn = publicTurnFromReceipt({ campaignId: "campaign_probe", fixture: false, backend: "lab", scenarioId: "ledger-redaction", payloadHash: "x", observed: `part:${encoded.slice(0, 8)}|${encoded.slice(8)}`, verdict: "contained", execution: { resultId: "e" } }, { hypothesis: `encoded:${encoded}`, sourceRevision: "a".repeat(40) });
    const output = JSON.stringify(turn);
    return output.includes(encoded) || output.includes(encoded.slice(0, 8))
      ? escaped("The public ledger preserved an encoded secret that can be reconstructed by readers.", { encoding: "base64" })
      : contained("Encoded secret material was removed before publication.");
  },
  "sibling-count-bypass": async () => {
    // Depth limits prevent recursion, but do not cap sequential siblings. This detector
    // counts whether a parent can request more child runs than a reasonable fanout cap.
    let accepted = 0;
    for (let i = 0; i < 6; i++) {
      try { await runTerrarium({ task: "noop", dryRun: true, agent: "node -e \"process.exit(0)\"", maxDepth: 3 }); accepted++; } catch {}
    }
    return accepted > 3 ? escaped(`A caller created ${accepted} sequential sibling runs without a fanout budget.`, { accepted }) : contained(`Sibling run budget held at ${accepted}.`, { accepted });
  },
  "dependency-pin-downgrade": async () => {
    const rev = "a".repeat(40);
    const patch = `diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-\"checker\":\"2.0.0\"\n+\"checker\":\"1.0.0\"\ndiff --git a/test/new-regression.test.js b/test/new-regression.test.js\n--- /dev/null\n+++ b/test/new-regression.test.js\n@@ -0,0 +1 @@\n+test('passes',()=>{});\n`;
    try { validateFixPatch({ patch, baseRevision: rev, expectedBaseRevision: rev }); return escaped("The fix gate accepted a dependency lockfile downgrade that could indirectly weaken a checker.", { path: "package-lock.json" }); }
    catch { return contained("The fix gate rejected the dependency downgrade."); }
  },
};

export async function runParameterizedProbe(probeId) {
  if (!PROBE_IDS.includes(probeId)) throw new Error(`unknown parameterized probe: ${probeId}`);
  return PROBES[probeId]();
}
