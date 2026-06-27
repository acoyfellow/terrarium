# Compatibility contract

Terrarium's primary product is a durable, runner-independent execution and callback layer for bounded delegated work. The original one-child primitive remains foundational. Batch fan-out, groups, callbacks, schedule replay, and the frozen public containment laboratory are additive layers; none replace the primitive.

## Stable primitive

```text
one bounded task → one child run → one inspectable result
```

The following interfaces are foundational and remain supported as containment work is added.

## CLI contract

Existing delegation continues to mean ordinary one-child execution. Runner and model selection are additive configuration, not a change in the one-child contract:

```sh
terra "task"
terra --agent "pi -p --no-session" --model <model-id> "task"
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
| `terrarium_spawn_batch` | Additive coordinator: create 1–256 independent ordinary runs under one group and resolve them with an explicit join strategy. Batches over 32 jobs require an explicit `concurrency` bound; a missing bound is rejected at `phase: "preflight"` (before any child launches) with a machine-readable `code` and a `suggestedConcurrency` value. |
| `terrarium_status` | Inspect one run or list/poll runs. |
| `terrarium_read` | Read a recorded Terrarium or MRE log. |
| `terrarium_cancel` | Additive control: cancel one active lineage-scoped run. |
| `terrarium_group` | Additive view: group existing independent runs; never spawns children. |
| `terrarium_callbacks` | Additive durable pull queue: scoped subscribe/claim/ack/status/requeue/recover/prune/unsubscribe; concrete subscriptions close finish-before-subscribe races. |
| `terrarium_doctor` | Additive top-level diagnostics for durable state, active/orphaned runs, groups, callbacks, and stale claims. Read-only over MCP; the `terra doctor --repair [--apply] [--verify]` CLI adds an opt-in, dry-run-by-default executor for the mechanically-safe recover/requeue/prune subset. `--verify` (with `--apply`) re-diagnoses after the repair and attaches a `residual` evidence block proving each self-healing condition's counter actually dropped to zero. |

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
spawnBatch({ jobs, strategy, concurrency })
replayScheduleFixture(fixture)
```

Higher-level coordination should compose these primitives or live in separate modules. `spawnBatch()` composes background spawns, groups, status, and cancellation; it does not change `runTerrarium()` semantics. `runTerrarium()` must not be repurposed into attack-only behavior.

## Durable behavior invariants

- One ordinary run owns one child process and one correlated receipt. Explicit batch coordination creates multiple independent ordinary runs; it must not collapse their metadata or callbacks into an uninspectable aggregate.
- Existing prompt profiles (`default`, `minimal`) remain compatible.
- Agent precedence remains explicit agent → configured read-only agent → environment default → config default → built-in OpenCode fallback.
- Model precedence is explicit `model` → `TERRARIUM_MODEL` → `config.defaultModel` → runner default; model metadata remains inspectable in run/status receipts.
- Existing environment lineage keys (`TERRARIUM_RUN_ID`, `TERRARIUM_PARENT_RUN_ID`, `TERRARIUM_DEPTH`, `TERRARIUM_MAX_DEPTH`, `TERRARIUM_MRE_LOG_PATH`) remain available for ordinary composed runs. Additive capability keys (`TERRARIUM_ALLOW_SPAWN`, `TERRARIUM_STATUS_SCOPE`, `TERRARIUM_READ_SCOPE`) prevent child runs from inspecting unrelated lineages.
- Existing metadata, log, patch, and workspace receipts remain inspectable through the stable status/read flow by top-level callers. Child callers are restricted to self/descendant lineage unless the parent explicitly grants `all`.
- MCP-spawned non-dry runs require a structured run/task receipt. Exit zero without correlation is returned as `inconclusive`/`ok:false`; concise and verbose response envelopes remain additive-compatible.
- A batch job or campaign action must leave an ordinary Terrarium run ID and receipt behind.
- A run emits at most one terminal result and one deterministic terminal callback event. The journal is written even with no online subscriber; concrete late subscriptions can replay it, while acknowledged events remain suppressed. Background terminal classification is driven by the pure run transition core; versioned schedule replay is diagnostic evidence, not a second persisted source of truth.
- The pure run transition core has two implementations — TypeScript (`src/run-machine.js`) and a faithful Go port (`internal/run`) — that must stay in lockstep on `RUN_MACHINE_VERSION` and terminal classification. The inert Go core `replay` command (`terra-core --stdin`, additive to `dry-run`/`status`/`version`) drives an ordered input sequence through the Go machine and returns the final terminal classification; `test/go-vs-ts-replay-conformance-shard-p.test.js` feeds identical sequences to both cores and asserts byte-for-byte parity of the consumer-facing terminal fields. Any change to one machine must be mirrored in the other or conformance fails.

## Security boundary distinction

Current Terrarium children inherit host execution authority and environment. Worktree/copy isolation avoids checkout collisions; it does not make an attacker safe.

A true adversarial campaign must opt into the existing secure-v1 Docker or Lab-backed containment path with scrubbed capabilities, subject to those profiles' documented limits. Adding that backend must not cause existing delegation calls to begin running under incompatible semantics without an explicit versioned decision.
