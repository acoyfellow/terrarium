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

The child MCP removes `terrarium_spawn` from `tools/list` when denied. Direct calls fail closed. Core lineage checks also protect direct CLI/Node status/read calls that inherit Terrarium environment variables.

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

## Retry policy

MCP `terrarium_spawn.maxRetries` is bounded to 0–2 and defaults to zero. Retries occur only for missing/malformed/mismatched task receipts. Background runs cannot retry automatically. Every attempt has a distinct run ID and the response lists `attemptRunIds`.

## Remaining boundary

Ordinary Terrarium children still execute as the invoking OS user. A child with general host filesystem tools may directly read `~/.terrarium` outside the MCP/CLI APIs. MCP/CLI lineage enforcement prevents accidental and tool-mediated sibling inspection, but strong filesystem confidentiality requires `terra secure-agent` or another sandboxed profile. Copy/worktree isolation is not a security sandbox.
