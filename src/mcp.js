#!/usr/bin/env node
import { createInterface } from "node:readline";
import { cancelRun, ensureTerminalCallback, getRunStatus, isRunAccessible, listRuns, readRun, runTerrarium, spawnTerrariumBackground, VERSION } from "./core.js";
import { createRunGroup, getRunGroupStatus, readRunGroupLogs } from "./groups.js";
import { spawnBatch, BATCH_STRATEGIES } from "./batch.js";
import { acknowledgeMailboxEvent, claimMailboxEvents, getMailboxStatus, getSubscriber, pruneRouter, registerSubscriber, requeueInflightEvents, unregisterSubscriber } from "./router.js";
import { diagnoseTerrarium } from "./doctor.js";

const tools = [
  {
    name: "terrarium_spawn",
    description: "Spawn exactly one child agent for one bounded task. For background=true, do not sleep or poll: terminal callbacks only. The Terrarium Pi extension automatically subscribes this session, durably claims/acks completion exactly once, and triggers an idle Pi turn (or queues a follow-up while busy). Without that host extension, use terrarium_callbacks pull claim/ack or terrarium_status. Omitted background remains synchronous.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The single bounded objective for the child agent. Be specific. Include 'do not edit files' for read-only digs." },
        agent: { type: "string", description: "Child command. Explicit agent overrides readOnly preset. Defaults through config/env to 'opencode run'. Recommended ephemeral Pi child: 'pi -p --no-session'." },
        model: { type: "string", description: "Pin the child model for opencode run or pi. Precedence: explicit model, TERRARIUM_MODEL, config.defaultModel, runner default." },
        readOnly: { type: "boolean", description: "Use the configured read-only child command when no explicit agent is given. Configure readOnlyAgent or TERRARIUM_READ_ONLY_AGENT; legacy fallback is opencode explore." },
        ephemeral: { type: "boolean", description: "For Pi agents, append --no-session unless an explicit session flag is already present. Default true." },
        profile: { type: "string", enum: ["default", "minimal"], description: "Child prompt profile. 'default' (full structured contract) or 'minimal' (lean shell for bounded read-only digs). Orthogonal to agent/readOnly. Default: 'default'." },
        cwd: { type: "string", description: "Working directory for the child. Default: current directory." },
        channel: { type: "string", description: "Callback channel. Defaults to the caller's working-directory basename, not the child cwd." },
        workflowId: { type: "string", description: "Optional external workflow correlation ID." },
        sessionId: { type: "string", description: "Optional parent session correlation ID." },
        isolation: { type: "string", enum: ["none", "copy", "worktree"], description: "Workspace separation mode. This is not a security sandbox. Default: none." },
        keepWorkspace: { type: "boolean", description: "Retain an isolated copy/worktree for inspection instead of cleaning it up." },
        timeoutMs: { type: "number", description: "Kill the child after this many milliseconds. Default: none." },
        needsAttentionAfterMs: { type: "number", minimum: 5000, maximum: 3600000, description: "Mark a running child needs-attention after this much time without observed output. Default: 60000." },
        maxDepth: { type: "number", description: "Maximum Terrarium recursion depth. Default: 3." },
        allowSpawn: { type: "boolean", description: "Grant the child one nested Terrarium spawn when depth permits. Minimal/maxDepth=1 runs default false." },
        statusScope: { type: "string", enum: ["self", "descendants", "all"], description: "Run-status visibility granted to the child. Default: descendants when spawn is allowed, otherwise self." },
        readScope: { type: "string", enum: ["self", "descendants", "all"], description: "Run-log visibility granted to the child. Default: descendants when spawn is allowed, otherwise self." },
        dryRun: { type: "boolean", description: "Print the child invocation without running it." },
        background: { type: "boolean", description: "Detach immediately. In Pi, the extension auto-subscribes and surfaces terminal completion; do not sleep/poll. Other hosts must pull callbacks or status. Pass verbose=true for pid/logPath fields." },
        logPath: { type: "string", description: "Override log file path. Default: ~/.terrarium/runs/<runId>.log" },
        mreLogPath: { type: "string", description: "Override MRE log file path passed to the child as TERRARIUM_MRE_LOG_PATH. Default: ~/.terrarium/runs/<runId>.mre.log" },
        maxRetries: { type: "number", minimum: 0, maximum: 2, description: "Bounded retries for missing/mismatched task receipts. Default: 0; background runs cannot retry." },
        verbose: { type: "boolean", description: "Return the full unprojected result envelope. Default: false (concise projection)." }
      },
      required: ["task"]
    }
  },
  {
    name: "terrarium_spawn_batch",
    description: "Fan out an array of jobs as independent background runs under one group, then resolve by join strategy. Each job is a normal single spawn (same options as terrarium_spawn). Strategies: all (every job must finish; ok if all succeed), allSettled (collect all outcomes, always ok), race (first terminal wins, cancel the rest), any (first success wins, cancel the rest), quorum (first k successes, cancel the rest). Winner-picking strategies cancel losing runs; prefer isolation copy|worktree for jobs with side effects. Capability-scoped like terrarium_spawn.",
    inputSchema: {
      type: "object",
      properties: {
        jobs: { type: "array", minItems: 1, maxItems: 32, description: "Job option objects, each accepting the same fields as terrarium_spawn (task required).", items: { type: "object", properties: { task: { type: "string" }, agent: { type: "string" }, model: { type: "string" }, readOnly: { type: "boolean" }, ephemeral: { type: "boolean" }, profile: { type: "string", enum: ["default", "minimal"] }, cwd: { type: "string" }, channel: { type: "string" }, workflowId: { type: "string" }, sessionId: { type: "string" }, isolation: { type: "string", enum: ["none", "copy", "worktree"] }, keepWorkspace: { type: "boolean" }, timeoutMs: { type: "number" }, needsAttentionAfterMs: { type: "number" }, maxDepth: { type: "number" }, allowSpawn: { type: "boolean" }, statusScope: { type: "string", enum: ["self", "descendants", "all"] }, readScope: { type: "string", enum: ["self", "descendants", "all"] }, logPath: { type: "string" }, mreLogPath: { type: "string" } }, required: ["task"] } },
        strategy: { type: "string", enum: BATCH_STRATEGIES, description: "Join strategy. Default: all." },
        quorum: { type: "number", description: "Required successes for the quorum strategy (1..jobs.length)." },
        concurrency: { type: "number", minimum: 1, description: "Max simultaneously launched runs. Default: launch all at once." },
        label: { type: "string", description: "Group label." },
        pollMs: { type: "number", description: "Status poll interval in ms. Default: 500." },
        timeoutMs: { type: "number", description: "Overall batch wait budget in ms; on timeout, remaining runs are cancelled." },
        verbose: { type: "boolean", description: "Return the full group envelope. Default: concise." }
      },
      required: ["jobs"]
    }
  },
  {
    name: "terrarium_status",
    description: "List/poll Terrarium runs within the caller's granted lineage scope. Child callers default to self or descendants and cannot inspect siblings. Concise by default; verbose returns the full allowed envelope.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max number of recent runs to return. Default: 20." },
        runId: { type: "string", description: "If set, return status for this single run instead of listing." },
        verbose: { type: "boolean", description: "Return the full unprojected envelope per run. Default: false (concise projection)." }
      }
    }
  },
  {
    name: "terrarium_read",
    description: "Read the tail of a recorded Terrarium log within the caller's granted lineage scope. Scoped child callers must use a runId and cannot read sibling logs.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run ID returned by terrarium_spawn." },
        logPath: { type: "string", description: "Recorded Terrarium log path. Use this or runId." },
        kind: { type: "string", enum: ["terrarium", "mre"], description: "Log kind to read by runId. Default: terrarium." },
        tailBytes: { type: "number", description: "Bytes from the end of the log to return. Default: 20000." }
      }
    }
  },
  {
    name: "terrarium_cancel",
    description: "Cancel one active run within the caller's lineage scope. Terminates the child process group and records cancelled status.",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] }
  },
  {
    name: "terrarium_group",
    description: "Create or inspect a parent-owned collection of already-started independent Terrarium runs. This tool does not spawn or fan out.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "status", "read", "cancel"] },
        groupId: { type: "string" },
        label: { type: "string" },
        runIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
        verbose: { type: "boolean" },
        kind: { type: "string", enum: ["terrarium", "mre"] },
        tailBytes: { type: "number" }
      },
      required: ["action"]
    }
  },
  {
    name: "terrarium_callbacks",
    description: "Low-level durable pull callbacks, terminal-only by default. Concrete run subscriptions replay finish-before-subscribe and offline/restart races; consumers atomically claim then ack exactly once. Subscribing alone does not wake a host. In Pi, prefer background terrarium_spawn: its extension auto-subscribes and triggers/queues delivery. Never sleep waiting for callbacks.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["subscribe", "claim", "ack", "status", "requeue", "recover", "prune", "unsubscribe"] },
        subscriberId: { type: "string" },
        runIds: { type: "array", items: { type: "string" }, maxItems: 100 },
        channels: { type: "array", items: { type: "string" }, maxItems: 100 },
        workflowIds: { type: "array", items: { type: "string" }, maxItems: 100 },
        eventTypes: { type: "array", items: { type: "string" }, maxItems: 100 },
        eventId: { type: "string" },
        runId: { type: "string", description: "Terminal run to recover into the durable callback journal and matching mailboxes." },
        limit: { type: "number" },
        olderThanMs: { type: "number" }
      },
      required: ["action"]
    }
  },
  {
    name: "terrarium_doctor",
    description: "Run read-only diagnostics for storage, active/orphaned runs, attention signals, callback queues, groups, and stale child claims.",
    inputSchema: { type: "object", properties: {} }
  }
];

function capabilityPolicy(env = process.env) {
  const requesterRunId = env.TERRARIUM_RUN_ID || null;
  return {
    requesterRunId,
    allowSpawn: requesterRunId ? env.TERRARIUM_ALLOW_SPAWN === "true" : true,
    statusScope: requesterRunId ? (env.TERRARIUM_STATUS_SCOPE || "self") : "all",
    readScope: requesterRunId ? (env.TERRARIUM_READ_SCOPE || "self") : "all",
  };
}

function visibleTools(policy) {
  return tools.filter((tool) => {
    if (!policy.allowSpawn && (tool.name === "terrarium_spawn" || tool.name === "terrarium_spawn_batch")) return false;
    if (policy.requesterRunId && tool.name === "terrarium_doctor") return false;
    return true;
  });
}

const SPAWN_ARG_KEYS = new Set(["task", "agent", "model", "readOnly", "ephemeral", "profile", "cwd", "channel", "workflowId", "sessionId", "isolation", "keepWorkspace", "timeoutMs", "needsAttentionAfterMs", "maxDepth", "allowSpawn", "statusScope", "readScope", "dryRun", "background", "logPath", "mreLogPath", "verbose"]);
function sanitizeSpawnArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args)) if (SPAWN_ARG_KEYS.has(key)) out[key] = value;
  out.requireTaskContract = true;
  return out;
}

async function runWithBoundedRetries(args, maxRetries) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 2) throw new Error("maxRetries must be an integer from 0 to 2");
  const attempts = [];
  for (let index = 0; index <= maxRetries; index++) {
    const result = await runTerrarium({ ...args, runId: undefined, stream: false });
    attempts.push(result.runId);
    if (result.ok || result.exitCode !== 0 || !["missing", "mismatch", "malformed"].includes(result.taskContractStatus)) return { ...result, attemptRunIds: attempts, retryCount: index };
  }
  return { ...(await getRunStatus({ runId: attempts.at(-1) })), attemptRunIds: attempts, retryCount: maxRetries };
}

const SPAWN_TAIL_CAP = 2000;
const SPAWN_ERR_TAIL_CAP = 500;

function defined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function capTail(s, cap) {
  if (typeof s !== "string" || s.length === 0) return undefined;
  return s.length > cap ? s.slice(-cap) : s;
}

export function conciseSpawn(full) {
  if (!full || typeof full !== "object") return full;
  const tail = capTail(full.stdoutTail, SPAWN_TAIL_CAP);
  const errTail = capTail(full.stderrTail, SPAWN_ERR_TAIL_CAP);
  return defined({
    ok: full.ok,
    runId: full.runId,
    status: full.status,
    model: full.model,
    background: full.background ? true : undefined,
    exitCode: full.exitCode,
    signal: full.signal,
    error: full.error,
    note: full.note,
    taskContractStatus: full.taskContractStatus,
    needsAttention: full.needsAttention,
    idleMs: full.idleMs,
    progressText: full.progressText,
    failureKind: full.failureKind,
    retryable: typeof full.retryable === "boolean" ? full.retryable : undefined,
    retryCount: full.retryCount,
    attemptRunIds: full.attemptRunIds,
    startedAt: full.startedAt,
    finishedAt: full.finishedAt,
    tail,
    tailTruncated: typeof full.stdoutTail === "string" && full.stdoutTail.length > SPAWN_TAIL_CAP ? true : undefined,
    errTail,
  });
}

export function conciseStatus(full) {
  if (!full || typeof full !== "object") return full;
  return defined({
    runId: full.runId,
    status: full.status,
    model: full.model,
    ok: full.ok,
    background: full.background ? true : undefined,
    alive: typeof full.alive === "boolean" ? full.alive : undefined,
    exitCode: full.exitCode,
    signal: full.signal,
    error: full.error,
    note: full.note,
    taskContractStatus: full.taskContractStatus,
    needsAttention: full.needsAttention,
    idleMs: full.idleMs,
    progressText: full.progressText,
    failureKind: full.failureKind,
    retryable: typeof full.retryable === "boolean" ? full.retryable : undefined,
    logAgeMs: full.logAgeMs,
    startedAt: full.startedAt,
    finishedAt: full.finishedAt,
    orphanedAt: full.orphanedAt,
  });
}

export function conciseListing(full) {
  if (!full || !Array.isArray(full.runs)) return full;
  return {
    count: full.runs.length,
    activeCount: Number(full.activeCount ?? 0),
    activeRunIds: Array.isArray(full.activeRunIds) ? full.activeRunIds : [],
    runs: full.runs.map((r) => defined({
      runId: r.runId,
      status: r.status,
      model: r.model,
      ok: r.ok,
      background: r.background ? true : undefined,
      alive: typeof r.alive === "boolean" ? r.alive : undefined,
      exitCode: r.exitCode,
      signal: r.signal,
      error: r.error,
      note: r.note,
      taskContractStatus: r.taskContractStatus,
      needsAttention: r.needsAttention,
      idleMs: r.idleMs,
      progressText: r.progressText,
      failureKind: r.failureKind,
      retryable: typeof r.retryable === "boolean" ? r.retryable : undefined,
      logAgeMs: r.logAgeMs,
      orphanedAt: r.orphanedAt,
      task: typeof r.task === "string" && r.task.length > 80 ? r.task.slice(0, 77) + "..." : r.task,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    })),
  };
}

export function conciseBatch(full) {
  if (!full || typeof full !== "object") return full;
  const group = full.group && typeof full.group === "object" ? full.group : {};
  return defined({
    ok: full.ok,
    strategy: full.strategy,
    groupId: full.groupId,
    reason: full.reason,
    winner: full.winner,
    winners: full.winners,
    timedOut: full.timedOut ? true : undefined,
    successCount: full.successCount,
    failureCount: full.failureCount,
    quorum: full.quorum,
    runIds: full.runIds,
    counts: group.counts,
    complete: group.complete,
    runs: Array.isArray(group.runs) ? group.runs.map((r) => defined({ runId: r.runId, status: r.status, ok: r.ok, exitCode: r.exitCode, taskContractStatus: r.taskContractStatus, error: r.error, note: r.note })) : undefined,
  });
}

function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
function content(obj, isError = false) { return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], isError }; }

async function handle(msg) {
  const policy = capabilityPolicy();
  if (msg.method === "initialize") return send(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "terrarium", version: VERSION } });
  if (msg.method === "tools/list") return send(msg.id, { tools: visibleTools(policy) });
  if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params ?? {};
    const verbose = args.verbose === true;
    try {
      if (name === "terrarium_spawn") {
        if (!policy.allowSpawn) throw new Error("Terrarium spawn capability denied for this run");
        const maxRetries = Number(args.maxRetries ?? 0);
        const backgroundDefault = process.env.TERRARIUM_BACKGROUND_BY_DEFAULT === "true";
        const background = args.background ?? (backgroundDefault && !args.dryRun && maxRetries === 0);
        if (background && maxRetries > 0) throw new Error("background Terrarium runs do not support retries");
        if (policy.requesterRunId && maxRetries > 0) throw new Error("nested Terrarium runs do not support retries; the parent owns retry policy");
        const safeArgs = sanitizeSpawnArgs({ ...args, background });
        const result = background ? await spawnTerrariumBackground(safeArgs) : await runWithBoundedRetries(safeArgs, maxRetries);
        const projected = verbose ? result : conciseSpawn(result);
        return send(msg.id, content(projected, !result.ok));
      }
      if (name === "terrarium_spawn_batch") {
        if (!policy.allowSpawn) throw new Error("Terrarium spawn capability denied for this run");
        if (policy.requesterRunId) throw new Error("nested Terrarium runs cannot fan out a batch; the top-level owner fans out");
        const jobs = Array.isArray(args.jobs) ? args.jobs.map((job) => ({ ...sanitizeSpawnArgs(job), background: true, dryRun: false })) : args.jobs;
        const result = await spawnBatch({ jobs, strategy: args.strategy, quorum: args.quorum, concurrency: args.concurrency, label: args.label, pollMs: args.pollMs, timeoutMs: args.timeoutMs });
        const projected = verbose ? result : conciseBatch(result);
        return send(msg.id, content(projected, !result.ok));
      }
      if (name === "terrarium_status") {
        if (args.runId || policy.statusScope !== "all") {
          const result = await getRunStatus({ ...args, runId: args.runId || policy.requesterRunId, requesterRunId: policy.requesterRunId, scope: policy.statusScope });
          return send(msg.id, content(verbose ? result : conciseStatus(result)));
        }
        const result = await listRuns({ ...args, requesterRunId: policy.requesterRunId, scope: policy.statusScope });
        return send(msg.id, content(verbose ? result : conciseListing(result)));
      }
      if (name === "terrarium_read") return send(msg.id, content(await readRun({ ...args, requesterRunId: policy.requesterRunId, scope: policy.readScope })));
      if (name === "terrarium_cancel") return send(msg.id, content(await cancelRun({ ...args, requesterRunId: policy.requesterRunId, scope: policy.statusScope })));
      if (name === "terrarium_group") {
        if (args.action === "create") return send(msg.id, content(await createRunGroup(args)));
        if (args.action === "status") return send(msg.id, content(await getRunGroupStatus(args)));
        if (args.action === "read") return send(msg.id, content(await readRunGroupLogs(args)));
        if (args.action === "cancel") {
          const group = await getRunGroupStatus({ groupId: args.groupId });
          const results = [];
          for (const run of group.runs) if (run.status === "running") results.push(await cancelRun({ runId: run.runId, requesterRunId: policy.requesterRunId, scope: policy.statusScope }));
          return send(msg.id, content({ groupId: args.groupId, cancelled: results }));
        }
        throw new Error("unknown Terrarium group action");
      }
      if (name === "terrarium_callbacks") {
        if (args.action === "subscribe") {
          const runIds = args.runIds ?? (policy.requesterRunId ? [policy.requesterRunId] : ["*"]);
          if (policy.requesterRunId) {
            if (runIds.includes("*")) throw new Error("child callback subscriptions require explicit lineage run IDs");
            for (const runId of runIds) if (!(await isRunAccessible({ requesterRunId: policy.requesterRunId, targetRunId: runId, scope: policy.statusScope }))) throw new Error("callback run access denied");
          }
          const subscriber = await registerSubscriber({ ...args, runIds, ownerRunId: policy.requesterRunId });
          const recovered = [];
          if (!runIds.includes("*")) for (const runId of runIds) recovered.push(await ensureTerminalCallback({ runId, requesterRunId: policy.requesterRunId, scope: policy.statusScope }));
          return send(msg.id, content({ ...subscriber, recovered }));
        }
        if (args.action === "recover") return send(msg.id, content(await ensureTerminalCallback({ runId: args.runId, requesterRunId: policy.requesterRunId, scope: policy.statusScope })));
        if (args.action === "prune") {
          if (policy.requesterRunId) throw new Error("callback pruning is available only to a top-level controller");
          return send(msg.id, content(await pruneRouter({
            acknowledgedOlderThanMs: args.olderThanMs,
            journalOlderThanMs: args.olderThanMs,
            callbackOlderThanMs: args.olderThanMs,
            subscriberOlderThanMs: args.olderThanMs,
          })));
        }
        const subscription = await getSubscriber(args.subscriberId);
        if (policy.requesterRunId && subscription.ownerRunId !== policy.requesterRunId) throw new Error("callback subscriber access denied");
        if (args.action === "claim") return send(msg.id, content(await claimMailboxEvents(args)));
        if (args.action === "ack") return send(msg.id, content(await acknowledgeMailboxEvent(args)));
        if (args.action === "status") return send(msg.id, content(await getMailboxStatus(args.subscriberId)));
        if (args.action === "requeue") return send(msg.id, content(await requeueInflightEvents({ subscriberId: args.subscriberId, olderThanMs: args.olderThanMs })));
        if (args.action === "unsubscribe") { await unregisterSubscriber(args.subscriberId); return send(msg.id, content({ subscriberId: args.subscriberId, unsubscribed: true })); }
        throw new Error("unknown Terrarium callback action");
      }
      if (name === "terrarium_doctor") {
        if (policy.requesterRunId) throw new Error("Terrarium doctor is available only to a top-level controller");
        return send(msg.id, content(await diagnoseTerrarium()));
      }
      return error(msg.id, -32602, `unknown tool: ${name}`);
    } catch (e) {
      return send(msg.id, content(e.message, true));
    }
  }
  if (msg.id) return error(msg.id, -32601, `unknown method: ${msg.method}`);
}

// Always attach stdio when invoked as this executable. The previous
// import.meta.url/process.argv comparison was brittle when launchers resolve a
// symlink to terrarium-mcp differently from Node, which made Pi see an MCP
// process that exited before initialize.
const isMainEntry = /(?:^|\/)(?:mcp\.js|terrarium-mcp)$/.test(process.argv[1] ?? "");

if (isMainEntry) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try { await handle(JSON.parse(line)); }
    catch (e) { error(null, -32700, e.message); }
  });
}
