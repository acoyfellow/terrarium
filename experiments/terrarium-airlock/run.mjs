#!/usr/bin/env node
// terrarium-airlock spike: Terrarium's own release driven through airlock's
// runPipeline. The anti-pattern this kills: treating every deploy as a scary
// manual gate. Here deploy-to-a-non-serving-slot is automatic, the fanout tests
// are REAL Terrarium qual probes, promotion is gated on a keel-signed proof
// bound to the candidate, and the ONLY human gate is the final prod pointer-flip
// (recorded as a request, never auto-flipped).
//
//   candidate (worker bundle digest)
//     -> deploy to non-serving *.workers.dev slot (already live: terrarium-qual-pi)
//     -> fanout^x REAL probes (health 200, /api/runs 401, one verified run, graded artifact re-verifies)
//     -> keel signs the evidence bound to the candidate digest
//     -> verifySignedProof admits -> promote (qual auto; prod = recorded request)
//
// Run: node --experimental-strip-types experiments/terrarium-airlock/run.mjs
// Requires: sibling ../airlock (exports runPipeline) + its keel dep; a live qual
// worker + token file at /tmp/terra-qual-token.secret.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");
const AIRLOCK = join(REPO, "../airlock");

// Import airlock's pure pipeline + keel's real signing/verification. Node 24
// strips the TS types; these are the SAME modules airlock ships.
const { runPipeline } = await import(join(AIRLOCK, "src/pipeline.ts"));
const keel = await import(join(AIRLOCK, "node_modules/keel/src/index.ts"));

// The non-prod qual slot base URL. Supply via env; no environment-specific
// hostname is baked into this public spike.
const QUAL = process.env.TERRA_QUAL_BASE;
if (!QUAL) { console.error("set TERRA_QUAL_BASE to your non-prod qual slot base URL"); process.exit(2); }
const TOKEN = readFileSync(process.env.TERRA_QUAL_TOKEN_FILE || "/tmp/terra-qual-token.secret", "utf8").trim();

// ---- candidate: content digest of the deployed worker bundle ---------------
// Honest content addressing: hash the built worker entry the deploy would ship.
function candidateDigest() {
  const bundle = join(REPO, "app/dist/assets");
  try {
    const files = execSync(`ls ${bundle} 2>/dev/null`).toString().trim();
    const h = createHash("sha256").update(files).update(readFileSync(join(REPO, "src/control-worker.js"))).digest("hex");
    return `sha256:${h.slice(0, 32)}`;
  } catch {
    return `sha256:${createHash("sha256").update(readFileSync(join(REPO, "src/control-worker.js"))).digest("hex").slice(0, 32)}`;
  }
}

function curlCode(url, extra = "") {
  return execSync(`curl -s -o /dev/null -w '%{http_code}' ${extra} ${url}`, { timeout: 30000 }).toString().trim();
}
function rid() { return `airlock-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8)}`; }

// ---- REAL fanout: probes against the deployed (already-serving) qual slot ---
// Each returns { name, ok, detail }. Never trust prose: check the observed fact.
const jobs = [
  { name: "health-200", run: () => ({ name: "health-200", ok: curlCode(`${QUAL}/health`) === "200", detail: `GET /health` }) },
  { name: "api-auth-401", run: () => ({ name: "api-auth-401", ok: curlCode(`${QUAL}/api/runs`, `-X POST -H 'content-type: application/json' -d '{}'`) === "401", detail: `unauth POST /api/runs` }) },
  {
    name: "verified-run", run: () => {
      const idem = rid();
      const admit = execSync(`curl -s -X POST ${QUAL}/api/runs -H 'authorization: Bearer ${TOKEN}' -H 'idempotency-key: ${idem}' -H 'content-type: application/json' -d '{"task":"Reply with exactly: airlock ok","spec":{"deadlineMs":150000}}'`, { timeout: 30000 }).toString();
      const runId = JSON.parse(admit).runId;
      // poll to terminal
      for (let i = 0; i < 40; i++) {
        const s = execSync(`curl -s ${QUAL}/api/runs/${runId}/status -H 'authorization: Bearer ${TOKEN}'`, { timeout: 30000 }).toString();
        const st = (JSON.parse(s).status || {});
        const tc = st.terminal?.taskContractStatus;
        if (["verified", "missing", "mismatch", "not-applicable"].includes(tc) || ["done", "failed", "cancelled", "inconclusive"].includes(st.status)) {
          return { name: "verified-run", ok: tc === "verified", detail: `${runId} -> ${tc}` };
        }
        execSync("sleep 5");
      }
      return { name: "verified-run", ok: false, detail: `${runId} -> poll-timeout` };
    },
  },
  {
    name: "graded-artifact-reverifies", run: async () => {
      const idem = rid();
      const admit = execSync(`curl -s -X POST ${QUAL}/api/runs -H 'authorization: Bearer ${TOKEN}' -H 'idempotency-key: ${idem}' -H 'content-type: application/json' -d '{"task":"Reply with exactly: graded probe","spec":{"deadlineMs":150000}}'`, { timeout: 30000 }).toString();
      const runId = JSON.parse(admit).runId;
      for (let i = 0; i < 40; i++) {
        const s = execSync(`curl -s ${QUAL}/api/runs/${runId}/status -H 'authorization: Bearer ${TOKEN}'`, { timeout: 30000 }).toString();
        const st = (JSON.parse(s).status || {});
        if (st.terminal) break;
        execSync("sleep 5");
      }
      const g = JSON.parse(execSync(`curl -s ${QUAL}/api/runs/${runId}/graded -H 'authorization: Bearer ${TOKEN}'`, { timeout: 30000 }).toString());
      if (!g.ok || !g.artifact) return { name: "graded-artifact-reverifies", ok: false, detail: "no artifact" };
      const { verifyReceiptArtifact } = await import(join(REPO, "src/cloud/receipt-artifact.js"));
      const v = await verifyReceiptArtifact(g.artifact);
      return { name: "graded-artifact-reverifies", ok: v.ok, detail: `${runId} artifact ${v.ok ? "re-verified" : v.reason}` };
    },
  },
];

// ---- ports ----------------------------------------------------------------
// Verifier identity: minted ephemerally for the spike (a real deploy would load
// it from CI secrets, per airlock's keys.ts). Only the public key is trusted.
const verifier = keel.makeKeyPair(); // { keyId, privatePem, publicPem }
const SIGN_POLICY = "terrarium/qual-fanout@1";
const candidate = candidateDigest();

const ports = {
  // deploy: the qual slot is ALREADY deployed (non-prod, serves no prod traffic).
  // The spike treats the live qual worker as the candidate's non-serving slot.
  deploy: async () => ({ url: QUAL, detail: "qual slot (non-prod)" }),
  // fanout: run the real probes (async run() fns) sequentially-but-joined.
  runFanout: async (jobList) => {
    const out = [];
    for (const j of jobList) {
      try { out.push(await j.run()); }
      catch (e) { out.push({ name: j.name, ok: false, detail: String(e.message || e).slice(0, 120) }); }
    }
    return out;
  },
  // sign: keel signs the evidence bound to the candidate digest (only key use).
  sign: (cand, evidence, pass) => keel.signProof(
    keel.makeProof({ artifactDigest: cand, verifier: verifier.keyId, policy: SIGN_POLICY, result: pass ? "pass" : "fail", evidence }),
    verifier.keyId,
    verifier.privatePem,
  ),
  trusted: { [verifier.keyId]: verifier.publicPem },
  // promote: qual auto-promote is a no-op record; prod pointer-flip is HUMAN-GATED.
  setFeatureGate: async (cand, on) => {
    mkdirSync(join(HERE, "out"), { recursive: true });
    const rec = { candidate: cand, on, at: new Date().toISOString(), note: on ? "qual proof admitted; prod promotion to terrarium.coey.dev is human-gated (recorded, not flipped)" : "gate left off" };
    writeFileSync(join(HERE, "out/PROMOTE_REQUEST.json"), JSON.stringify(rec, null, 2));
  },
};

console.log(`terrarium-airlock: candidate ${candidate}`);
console.log(`  slot ${QUAL}  (fanout = real qual probes)\n`);
const receipt = await runPipeline({ repo: "terrarium", candidate }, jobs, ports);
console.log("--- pipeline receipt ---");
console.log(`  candidate  ${receipt.candidate}`);
console.log(`  evidence   ${receipt.evidence}`);
console.log(`  admitted   ${receipt.admitted}`);
console.log(`  promoted   ${receipt.promoted}`);
console.log(`  reason     ${receipt.reason}`);
mkdirSync(join(HERE, "out"), { recursive: true });
writeFileSync(join(HERE, "out/RECEIPT.json"), JSON.stringify(receipt, null, 2));
process.exitCode = receipt.admitted ? 0 : 1;
