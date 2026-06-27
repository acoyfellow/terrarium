# Concurrency and context isolation

## Incident

On 2026-06-20 four independent top-level read-only research runs were launched in parallel. All four child processes exited zero, but three returned summaries about sibling tasks instead of their assigned task.

Forensics showed:

- each run metadata file retained the correct distinct task;
- A's output explicitly said it read C's Terrarium log;
- B's output explicitly said it read A's Terrarium log;
- C's output explicitly said it read D's Terrarium log;
- each run left a `.children/1` claim for a rejected nested Terrarium attempt;
- those nested run IDs had no metadata because max-depth validation failed after the claim was written.

## Root cause

The defect was a composition of four independent gaps:

1. Pi children inherited the global Terrarium MCP. `maxDepth` rejected execution, but did not remove the tool capability.
2. `terrarium_status` and `terrarium_read` had global visibility. A child could enumerate/read sibling runs without a lineage check.
3. `claimChildSlot()` ran before max-depth/task/agent validation, so rejected nested attempts left orphan claims.
4. Exit code zero was treated as task success. Output had no trusted correlation to run ID or delegated task.

Parallel log files and metadata were separate; the contamination did not come from file-name collisions. The children intentionally queried unrelated Terrarium runs and summarized those results.

## Enforcement

Each spawned run now receives a machine-readable capability policy:

```text
TERRARIUM_ALLOW_SPAWN
TERRARIUM_STATUS_SCOPE=self|descendants|all
TERRARIUM_READ_SCOPE=self|descendants|all
```

Defaults:

- minimal or max-depth-one child: no spawn, self status, self reads;
- child allowed one nested spawn: descendants status/reads;
- top-level controller MCP: all visibility;
- inherited scopes cannot be widened by a child.

The child MCP removes both `terrarium_spawn` and `terrarium_spawn_batch` from `tools/list` when spawn is denied. Batch fan-out is top-level owned; nested callers cannot invoke it even when ordinary nested spawn is available. Direct calls fail closed. Core lineage checks also protect direct CLI/Node status/read calls that inherit Terrarium environment variables.

Child-slot claiming happens after non-mutating validation. A failure after claiming releases the slot and removes partial metadata/log files.

## Task contract

MCP-spawned children receive a per-run nonce and SHA-256 task fingerprint. Their final output must contain exactly one structured line:

```text
TERRARIUM_RESULT={"runId":"...","taskFingerprint":"...","nonce":"...","summary":"..."}
```

Exit zero plus a missing, malformed, or mismatched receipt becomes:

```text
status: inconclusive
ok: false
taskContractStatus: missing|malformed|mismatch
```

This proves output/run/task correlation, not semantic truth. Parents must still verify substantive claims.

## Explicit batch fan-out

`terrarium_spawn_batch` accepts 1–32 job objects and launches each through the normal detached spawn path. Every job keeps its own run ID, task contract, metadata, logs, terminal callback, and lineage. One durable group provides correlation.

Join strategies are:

- `all`: wait for all jobs; success only when all succeed;
- `allSettled`: wait for and collect every outcome;
- `race`: the earliest-finishing terminal result wins, then cancel remaining runs;
- `any`: the earliest-finishing successful result wins, then cancel remaining runs;
- `quorum`: the earliest-finishing requested number of successes win, then cancel remaining runs.

Winners are chosen by per-run finish time (`finishedAt`), not by the order jobs were listed. Because a single status poll can observe several runs that all went terminal within the interval, ordering by finish time keeps "first wins" honest; exact ties break deterministically by run ID, and a terminal run whose finish time is not yet readable sorts last so it cannot out-race a run that provably finished earlier.

Optional `concurrency` bounds simultaneous launches. For write-capable winner-picking jobs, use copy/worktree isolation so cancellation does not leave competing edits in the caller's checkout.

## Terminal race invariants

Detached background runs use `transition(state, input) -> { state, decisions }` to guarantee at most one terminal result and one deterministic completion event. The callback router journals that event without requiring an online subscriber. Concrete subscriptions replay a completion that raced ahead; Pi retains its session subscriber/mailbox across shutdown and requeues abandoned inflight claims on resume. Cancellation intent is durable across the launcher/supervisor handoff. Versioned schedule fixtures exercise cancellation-before-completion, completion-before-cancellation, virtual deadlines, and seeded bounded permutations without process sleeps. See [RUN_SCHEDULES.md](./RUN_SCHEDULES.md).

## Retry policy

MCP `terrarium_spawn.maxRetries` is bounded to 0–2 and defaults to zero. Retries occur only for missing/malformed/mismatched task receipts. Background runs cannot retry automatically. Every attempt has a distinct run ID and the response lists `attemptRunIds`.

## Remaining boundary

Ordinary Terrarium children still execute as the invoking OS user. A child with general host filesystem tools may directly read `~/.terrarium` outside the MCP/CLI APIs. MCP/CLI lineage enforcement prevents accidental and tool-mediated sibling inspection, but strong filesystem confidentiality requires `terra secure-agent` or another sandboxed profile. Copy/worktree isolation is not a security sandbox.
