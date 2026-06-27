#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { cancelRun, getRunStatus, listRuns, readRun, runTerrarium, VERSION } from "./core.js";
import { createRunGroup, getRunGroupStatus, readRunGroupLogs } from "./groups.js";
import { spawnBatch } from "./batch.js";
import { campaignIssueDraft, createFixtureCampaign, DEFAULT_SANDBOX_IMAGE, FIXTURE_SCENARIO_IDS, FIXTURE_VARIANTS, listCampaignReceipts, readCampaignReceipt, runAttackExperiment, runSandboxScenario, SCENARIO_IDS, verifyCampaignReceipt, verifySandboxScenario } from "./sandbox.js";
import { runManualHostile } from "./hostile-cli.js";
import { runHealingLoop } from "./healing-cli.js";
import { replayAndMerge } from "./replay-gate.js";
import { scenarioCatalog } from "./scenario-registry.js";
import { runRegistryCampaign } from "./campaign-cli.js";
import { buildCampaignMemory } from "./campaign-memory.js";
import { generatePlans } from "./campaign-strategist.js";
import { runSecureTask } from "./secure.js";
import { verifyHardening } from "./hardening.js";
import { runSecureAgent } from "./secure-agent.js";
import { diagnoseTerrarium } from "./doctor.js";
import { replayScheduleFile } from "./schedule-replay.js";
import { goCoreVersion, goCoreDryRun } from "./go-core-adapter.ts";
import { detectMistypedCommand } from "./command-guard.js";

function help() {
  return `terrarium ${VERSION}

A tiny orchestrator. It accepts one task and may run exactly one child agent.
The child agent may be Terrarium too, with depth guards.

Usage:
  terra "task to run"
  terra --agent "opencode run" "task"
  terra --agent "pi -p --no-session" --model <model-id> "task"
  terra --read-only "task"
  terra --profile minimal "task"
  terra --dry-run "task"
  terra --task "status of the migration"   force prose that looks like a command to run as a task
  terra --json "task"
  terra --isolation copy "task"
  terra --isolation worktree "task"
  terra plan "task"            print the inert child-invocation plan (Go-accelerated, JS fallback)
  terra status [runId]
  terra read <runId> [tailBytes]
  terra read <runId> mre [tailBytes]
  terra cancel <runId>
  terra batch [--strategy all|allSettled|race|any|quorum] [--concurrency N] [--quorum K] [--batch-timeout-ms N] [--cleanup-timeout-ms N] "task1" "task2" ...
  terra group create <label> <runId...>
  terra group status <groupId>
  terra group read <groupId>
  terra probe <scenarioId> [--image node:22-alpine] [--json]
  terra verify <scenarioId> [--image node:22-alpine] [--json]
  terra attack <scenarioId> [--agent "opencode run"] [--json]
  terra campaigns [limit]
  terra scenarios
  terra campaign local [--scenarios a,b,c] [--agent "pi -p --no-session"] [--model <id>]
  terra campaign strategize [--turns 8] [--model <id>]
  terra secure "task"
  terra secure-agent --model <id> "task"
  terra hardening verify
  terra doctor
  terra schedule replay <fixture.json>
  terra campaign read <campaignId>
  terra campaign verify <campaignId>
  terra campaign issue-draft <campaignId>
  terra fixture escape [vulnerable|fixed]
  terra hostile run [--turns 3] [--agent "pi -p --no-session"] [--model <id>]
  terra heal <issue-number> <finding-json> [--agent "pi -p --no-session"] [--model <id>]
  terra heal-replay <pr-number> <private-finding-json> [--dry-run]

Containment probes (opt-in; ordinary delegation is unchanged):
  ${SCENARIO_IDS.join("\n  ")}

Known-vulnerable pipeline fixtures (local testing only; not real findings):
  ${FIXTURE_SCENARIO_IDS.join("\n  ")}
  variants: ${FIXTURE_VARIANTS.join(", ")}

Options:
  --agent <cmd>      Child command for ordinary runs or proposal agent for terra attack.
                     Ordinary default: config, $TERRARIUM_AGENT, or "opencode run".
                     Example: "pi -p --no-session" avoids persistent child sessions.
                     Explicit --agent overrides --read-only.
  --model <id>       Pin the child model. Supported for opencode run and pi agents.
                     Default: $TERRARIUM_MODEL, config.defaultModel, or runner default.
  --read-only        Use config.readOnlyAgent, $TERRARIUM_READ_ONLY_AGENT, or
                     the legacy opencode explore preset. Good for read-only digs.
  --profile <name>   Child prompt profile: default or minimal. Default: default.
                     Orthogonal to --agent / --read-only.
  --cwd <path>       Child working directory. Default: current directory
  --timeout-ms <n>   Kill child after n milliseconds. Default: config or no timeout
  --batch-timeout-ms <n>
                     Overall terra batch wait budget before cancelling unfinished runs
  --cleanup-timeout-ms <n>
                     Batch cancellation settlement wait. Default: 5000
  --max-depth <n>    Maximum Terrarium depth. Default: config or 3
  --dry-run          Print the child invocation without running it
  --json             Print structured JSON result
  --isolation <mode> Workspace isolation: none, copy, or worktree. Default: none
  --keep-workspace   Do not delete an isolated workspace created by ordinary delegation
  --log <path>       Write a transcript to this path
  --image <name>     Container image for terra probe. Default: ${DEFAULT_SANDBOX_IMAGE}
  --unsafe-network   Probe/verify negative control: attach Docker bridge network instead of denying network
  --help             Show help
  --version          Show version
`;
}

function parse(argv) {
  const out = { dryRun: false, json: false, logPath: null, cwd: process.cwd(), task: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--keep-workspace") out.keepWorkspace = true;
    else if (a === "--unsafe-network") out.unsafeNetwork = true;
    else if (a === "--read-only" || a === "--readonly") out.readOnly = true;
    else if (a === "--task") out.forceTask = true;
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--agent") out.agent = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--image") out.image = argv[++i];
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]);
    else if (a === "--cleanup-timeout-ms") out.cleanupTimeoutMs = Number(argv[++i]);
    else if (a === "--batch-timeout-ms") out.batchTimeoutMs = Number(argv[++i]);
    else if (a === "--turns") out.turns = Number(argv[++i]);
    else if (a === "--scenarios") out.scenarios = argv[++i];
    else if (a === "--publish") out.publish = true;
    else if (a === "--controller") out.controller = argv[++i];
    else if (a === "--isolation") out.isolation = argv[++i];
    else if (a === "--strategy") out.strategy = argv[++i];
    else if (a === "--quorum") out.quorum = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--poll-ms") out.pollMs = Number(argv[++i]);
    else if (a === "--max-depth") out.maxDepth = Number(argv[++i]);
    else if (a === "--log") out.logPath = argv[++i];
    else out.task.push(a);
  }
  return out;
}

const opts = parse(process.argv.slice(2));
const [cmd, ...rest] = opts.task;
// Fail closed on a likely-mistyped subcommand instead of silently spawning a
// child agent to "run" the typo. --task or TERRARIUM_NO_COMMAND_GUARD=1 opts out.
if (!opts.help && !opts.version && !opts.forceTask && process.env.TERRARIUM_NO_COMMAND_GUARD !== "1") {
  const mistyped = detectMistypedCommand(opts.task);
  if (mistyped) { console.error(`terrarium: ${mistyped.message}`); process.exit(2); }
}
if (opts.help) console.log(help());
else if (opts.version) { const v = goCoreVersion(); console.log(opts.json ? JSON.stringify({ ...v.value, source: v.source, ...(v.fallbackReason ? { fallbackReason: v.fallbackReason } : {}) }) : v.value.version); }
else if (cmd === "plan") {
  // Read-only: compute the inert child-invocation plan (Go-accelerated when
  // TERRARIUM_GO_CORE is set, JS fallback otherwise). No spawn, no mutation.
  const out = goCoreDryRun({ task: rest.join(" ").trim(), agent: opts.agent, cwd: opts.cwd });
  console.log(opts.json ? JSON.stringify({ ...out.value, source: out.source, ...(out.fallbackReason ? { fallbackReason: out.fallbackReason } : {}) }, null, 2) : `${out.value.agent} (${out.value.core}) :: ${out.value.task}`);
}
else if (cmd === "status" && rest[0]?.startsWith("ter_")) getRunStatus({ runId: rest[0] }).then((r) => console.log(JSON.stringify(r, null, 2)));
else if (cmd === "status") listRuns({ limit: Number(rest[0] || 20) }).then((r) => console.log(JSON.stringify(r, null, 2)));
else if (cmd === "read") readRun({ runId: rest[0], tailBytes: Number(rest[1] === "mre" ? rest[2] || 20000 : rest[1] || 20000), kind: rest[1] === "mre" ? "mre" : "terrarium" }).then((r) => console.log(r.text));
else if (cmd === "cancel") cancelRun({ runId: rest[0] }).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "batch") spawnBatch({ jobs: rest.map((task) => ({ task, agent: opts.agent, model: opts.model, profile: opts.profile, cwd: opts.cwd, isolation: opts.isolation, timeoutMs: opts.timeoutMs, requireTaskContract: true })), strategy: opts.strategy || "all", quorum: opts.quorum, concurrency: opts.concurrency, pollMs: opts.pollMs, timeoutMs: opts.batchTimeoutMs, cleanupTimeoutMs: opts.cleanupTimeoutMs }).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "group" && rest[0] === "create") createRunGroup({ label: rest[1], runIds: rest.slice(2) }).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "group" && rest[0] === "status") getRunGroupStatus({ groupId: rest[1], verbose: opts.verbose }).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "group" && rest[0] === "read") readRunGroupLogs({ groupId: rest[1] }).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "probe") runSandboxScenario({ scenarioId: rest[0], image: opts.image, unsafeNetwork: opts.unsafeNetwork }).then((result) => {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "inconclusive" ? 1 : 0);
}).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "verify") verifySandboxScenario({ scenarioId: rest[0], image: opts.image, unsafeNetwork: opts.unsafeNetwork }).then((result) => {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "inconclusive" ? 1 : 0);
}).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "attack") runAttackExperiment({ scenarioId: rest[0], agent: opts.agent, image: opts.image, unsafeNetwork: opts.unsafeNetwork, timeoutMs: opts.timeoutMs }).then((result) => {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "inconclusive" ? 1 : 0);
}).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "secure-agent") runSecureAgent({ task: rest.join(" "), cwd: opts.cwd, model: opts.model, timeoutMs: opts.timeoutMs || undefined }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "secure") runSecureTask({ task: rest.join(" "), cwd: opts.cwd, timeoutMs: opts.timeoutMs || undefined }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "doctor") diagnoseTerrarium().then((result) => { console.log(JSON.stringify(result, null, 2)); process.exit(result.ok ? 0 : 1); }).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "schedule" && rest[0] === "replay") replayScheduleFile(rest[1]).then((result) => { console.log(JSON.stringify(result, null, 2)); process.exit(result.ok ? 0 : 1); }).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "hardening" && rest[0] === "verify") verifyHardening({ cwd: opts.cwd }).then((result) => { console.log(JSON.stringify(result, null, 2)); process.exit(result.ok ? 0 : 1); }).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "scenarios") console.log(JSON.stringify(scenarioCatalog(), null, 2));
else if (cmd === "campaign" && rest[0] === "strategize") fetch(`${(opts.controller || process.env.TERRARIUM_CONTROLLER_URL || "https://terrarium.coey.dev").replace(/\/$/, "")}/api/demo`).then((r) => r.json()).then((campaign) => generatePlans({ memory: buildCampaignMemory(campaign.turns, { revision: campaign.turns.at(-1)?.sourceRevision }), catalog: scenarioCatalog(), count: opts.turns || 8, agent: opts.agent, model: opts.model, timeoutMs: opts.timeoutMs })).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "campaign" && rest[0] === "local") runRegistryCampaign({ scenarios: opts.scenarios ? opts.scenarios.split(",") : undefined, agent: opts.agent, model: opts.model, timeoutMs: opts.timeoutMs, controller: opts.publish ? (opts.controller || process.env.TERRARIUM_CONTROLLER_URL) : undefined, token: opts.publish ? process.env.TERRARIUM_CONTROL_TOKEN : undefined }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "campaigns") listCampaignReceipts({ limit: Number(rest[0] || 20) }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "campaign" && rest[0] === "read") readCampaignReceipt({ campaignId: rest[1] }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "campaign" && rest[0] === "verify") verifyCampaignReceipt({ campaignId: rest[1], image: opts.image, unsafeNetwork: opts.unsafeNetwork }).then((result) => {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "inconclusive" ? 1 : 0);
}).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "campaign" && rest[0] === "issue-draft") campaignIssueDraft({ campaignId: rest[1], image: opts.image, unsafeNetwork: opts.unsafeNetwork }).then((result) => {
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.markdown);
}).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "fixture" && rest[0] === "escape") createFixtureCampaign({ variant: rest[1] || "vulnerable" }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "hostile" && rest[0] === "run") runManualHostile({ scenarioId: rest[1] || "lab-env-canary", turns: opts.turns || 1, agent: opts.agent, model: opts.model, controller: opts.controller || process.env.TERRARIUM_CONTROLLER_URL, token: process.env.TERRARIUM_CONTROL_TOKEN, timeoutMs: opts.timeoutMs }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "heal") readFile(rest[1], "utf8").then(JSON.parse).then((finding) => runHealingLoop({ issueNumber: Number(rest[0]), finding, agent: opts.agent, model: opts.model, timeoutMs: opts.timeoutMs, dryRun: opts.dryRun })).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else if (cmd === "heal-replay") readFile(rest[1], "utf8").then(JSON.parse).then((finding) => replayAndMerge({ prNumber: Number(rest[0]), finding, baseUrl: process.env.LAB_ORIGIN || "https://lab.coey.dev", authToken: process.env.LAB_AUTH_TOKEN, merge: !opts.dryRun })).then((result) => console.log(JSON.stringify(result, null, 2))).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
else runTerrarium({ ...opts, task: opts.task.join(" ").trim(), stream: !opts.json }).then((result) => {
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  process.exit(result.exitCode ?? (result.ok ? 0 : 1));
}).catch((e) => { console.error(`terrarium: ${e.message}`); process.exit(1); });
