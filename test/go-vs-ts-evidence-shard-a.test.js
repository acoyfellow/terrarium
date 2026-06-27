// Shard-A Go-vs-TS evidence: gated, deterministic real-run + cross-core parity.
//
// These tests are the CI-portable distillation of
// experiments/go-vs-ts-evidence/shard-a/harness.mjs. They run REAL bounded
// Terrarium runs through the JS path against a deterministic receipt-emitting
// child (no LLM, no network), assert every receipt classification, and — when a
// Go core binary is available — assert the Go core agrees with the JS run
// machine on initial state and echoes exact run ids.
//
// The Go overlap is conditional: if `go` is not installed (and no
// TERRARIUM_GO_CORE override is provided) those assertions are skipped rather
// than failing, so the suite stays portable. The JS real-run assertions always
// run.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTerrarium, metadataPath } from "../src/core.js";
import { initialRunState } from "../src/run-machine.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureAgent = join(repoRoot, "test", "fixtures", "go-vs-ts-receipt-agent.mjs");
const API_VERSION = "terrarium-api-2026-06-26";

const CASES = [
  { mode: "verified", status: "done", receipt: "verified", ok: true },
  { mode: "missing", status: "inconclusive", receipt: "missing", ok: false },
  { mode: "mismatch", status: "inconclusive", receipt: "mismatch", ok: false },
  { mode: "malformed", status: "inconclusive", receipt: "malformed", ok: false },
  { mode: "nonzero", status: "failed", receipt: "verified", ok: false },
];

function resolveGoBinary() {
  if (process.env.TERRARIUM_GO_CORE) return process.env.TERRARIUM_GO_CORE;
  const out = join(tmpdir(), "terra-core-shardA-test");
  const b = spawnSync("go", ["build", "-o", out, "./cmd/terra-core"], { cwd: repoRoot, encoding: "utf8" });
  return b.status === 0 ? out : null;
}

function goCore(bin, args, input) {
  const r = spawnSync(bin, args, { input, encoding: "utf8", timeout: 5000 });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout || ""); } catch {}
  return { status: r.status, parsed };
}

// Lineage env makes runs into budget-limited grandchildren when the suite runs
// inside a Terrarium child. Strip it so these are deterministic top-level runs.
// (scripts/test-isolated.mjs already does this; we repeat it for standalone
// `node --test` invocations.)
const LINEAGE_KEYS = ["TERRARIUM_RUN_ID", "TERRARIUM_PARENT_RUN_ID", "TERRARIUM_STATUS_SCOPE", "TERRARIUM_READ_SCOPE", "TERRARIUM_DEPTH", "TERRARIUM_MAX_DEPTH", "TERRARIUM_ALLOW_SPAWN", "TERRARIUM_CHILD_BUDGET", "TERRARIUM_EVENT_CHANNEL", "TERRARIUM_MRE_LOG_PATH", "TERRARIUM_WORKFLOW_ID", "TERRARIUM_SESSION_ID"];

test("shard-A: five real JS runs classify every receipt status", async () => {
  for (const k of LINEAGE_KEYS) delete process.env[k];
  const home = await mkdtemp(join(tmpdir(), "terrarium-shardA-test-"));
  const prevHome = process.env.TERRARIUM_HOME;
  process.env.TERRARIUM_HOME = home;
  try {
    for (const c of CASES) {
      process.env.TERRARIUM_FIXTURE_MODE = c.mode;
      const result = await runTerrarium({
        task: `shard-a evidence ${c.mode}`,
        agent: `node ${JSON.stringify(fixtureAgent)}`,
        cwd: repoRoot,
        stream: false,
        requireTaskContract: true,
        timeoutMs: 30000,
      });
      delete process.env.TERRARIUM_FIXTURE_MODE;

      assert.match(result.runId, /^ter_/, `${c.mode}: run id prefix`);
      assert.equal(result.status, c.status, `${c.mode}: status`);
      assert.equal(result.taskContractStatus, c.receipt, `${c.mode}: receipt`);
      assert.equal(result.ok, c.ok, `${c.mode}: ok`);

      const persisted = JSON.parse(await readFile(metadataPath(result.runId), "utf8"));
      assert.equal(persisted.status, result.status, `${c.mode}: persisted status matches return`);
      assert.equal(persisted.taskContractStatus, result.taskContractStatus, `${c.mode}: persisted receipt matches return`);
    }
  } finally {
    if (prevHome === undefined) delete process.env.TERRARIUM_HOME; else process.env.TERRARIUM_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("shard-A: Go core agrees with JS run machine (skipped if go unavailable)", (t) => {
  const bin = resolveGoBinary();
  if (!bin) { t.skip("go core unavailable (no go toolchain and no TERRARIUM_GO_CORE)"); return; }

  const version = goCore(bin, ["version"]);
  assert.equal(version.status, 0, "go version exit 0");
  assert.equal(version.parsed?.version?.api, API_VERSION, "go api version matches JS");

  const jsInit = initialRunState({ requireReceipt: true });
  const dry = goCore(bin, ["--stdin"], JSON.stringify({ command: "dry-run", task: "parity", agent: "opencode run", requireReceipt: true }));
  assert.equal(dry.parsed?.ok, true, "go dry-run ok");
  const goInit = dry.parsed?.dryRun?.initialState;
  assert.equal(goInit.version, jsInit.version, "machine version parity");
  assert.equal(goInit.phase, jsInit.phase, "initial phase parity");
  assert.equal(goInit.requireReceipt, jsInit.requireReceipt, "requireReceipt parity");
  assert.equal(goInit.receipt, jsInit.receipt, "initial receipt parity");

  const runId = "ter_20260627000000000_shardA0";
  const status = goCore(bin, ["status", runId]);
  assert.equal(status.parsed?.ok, true, "go status ok");
  assert.equal(status.parsed?.status?.runId, runId, "go status echoes exact run id");
  assert.equal(status.parsed?.apiVersion, API_VERSION, "go status api version parity");
});
