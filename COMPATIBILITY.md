# Compatibility contract

Terrarium is growing from a context-preserving child-run tool into a public laboratory for testing AI-agent containment. The laboratory is built on the existing primitive; it does not replace it.

## Stable primitive

```text
one bounded task → one child run → one inspectable result
```

The following interfaces are foundational and remain supported as containment work is added.

## CLI contract

Existing delegation continues to mean ordinary one-child execution:

```sh
terra "task"
terra --read-only "research task"
terra --profile minimal "bounded dig"
terra --isolation worktree "patch in a separate workspace"
terra status [runId]
terra read <runId> [mre] [tailBytes]
```

New containment or campaign commands/options, if introduced, are additive and opt-in.

`--isolation none|copy|worktree` means **workspace separation**. It must not silently change meaning or be presented as a security sandbox.

## MCP contract

These tools remain available with their present ordinary-run meaning:

| Tool | Stable purpose |
| --- | --- |
| `terrarium_spawn` | Spawn exactly one child agent for one bounded delegated task. |
| `terrarium_status` | Inspect one run or list/poll runs. |
| `terrarium_read` | Read a recorded Terrarium or MRE log. |

Existing arguments preserve their semantics. Optional fields may be added later for sandbox selection, run role, scenario identity, or campaign identity; ordinary callers do not need them.

Concise responses remain the default so MCP use does not recreate the context pollution Terrarium was built to prevent. Detailed envelopes remain opt-in with `verbose: true` and persisted on disk.

## Node API contract

The low-level run functions continue to represent ordinary child execution:

```js
runTerrarium(opts)
spawnTerrariumBackground(opts)
getRunStatus({ runId })
listRuns({ limit })
readRun({ runId, kind })
```

Containment campaigns should compose these primitives or be implemented in new higher-level modules. `runTerrarium()` must not be repurposed into attack-only behavior.

## Durable behavior invariants

- One Terrarium process owns one child process at a time.
- Existing prompt profiles (`default`, `minimal`) and agent-resolution precedence remain compatible.
- Existing environment lineage keys (`TERRARIUM_RUN_ID`, `TERRARIUM_PARENT_RUN_ID`, `TERRARIUM_DEPTH`, `TERRARIUM_MAX_DEPTH`, `TERRARIUM_MRE_LOG_PATH`) remain available for ordinary composed runs.
- Existing metadata, log, patch, and workspace receipts remain inspectable through the stable status/read flow.
- A campaign action must leave an ordinary Terrarium run ID and receipt behind.

## Security boundary distinction

Current Terrarium children inherit host execution authority and environment. Worktree/copy isolation avoids checkout collisions; it does not make an attacker safe.

A true adversarial campaign must opt into a future sandbox/containment backend with scrubbed capabilities. Adding that backend must not cause existing delegation calls to begin running under incompatible semantics without an explicit versioned decision.
