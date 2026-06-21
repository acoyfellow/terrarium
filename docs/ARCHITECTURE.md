# Terrarium architecture

Terrarium has two additive modes:

```text
terra "task"          cooperative one-child delegation (stable compatibility surface)
terra secure "task"   hostile/untrusted secure-v1 validation profile
```

## Ordinary-run isolation

Parallel top-level runs keep separate metadata/logs and may execute concurrently. Each child receives a lineage-scoped capability policy: minimal/max-depth-one runs have no recursive spawn and self-only status/read; explicitly nested runs may see descendants but not siblings. MCP results require a run/task-correlated receipt, so process success is not automatically task success. See [CONCURRENCY_ISOLATION.md](./CONCURRENCY_ISOLATION.md).

## Seven-minute model

```text
PLAN → RUN → CHECK → REPLAY → FIX → RECHECK → MERGE
```

- **Planner:** proposes bounded attacks; never decides success.
- **Runner:** Docker or Lab fresh environment.
- **Checker:** scenario-owned deterministic detector outside attacker authority.
- **Evidence:** private receipt plus allowlisted public summary.
- **Fixer:** issue-scoped worktree; no publish/merge authority.
- **Patch gate:** protects detectors, workflows, evidence policy, dependencies.
- **Replay gate:** same payload, same detector, fresh environment.
- **Merger:** serial trusted controller after tests and replay.

## State machine

```text
planned
→ detector_started
→ detector_finished
→ [contained | replay_started]
→ replay_finished
→ [not_reproduced | finding_classified]
→ finding_published
→ fix_started
→ [patch_rejected | patch_accepted]
→ tests_passed
→ post_fix_replay_contained
→ merged
→ stopped
```

Every public event is allowlisted and bounded. Callback subscriptions can filter by run, channel, workflow, and event type. Events receive deterministic IDs; duplicate routing is suppressed. Consumers atomically move callbacks from pending to inflight and explicitly acknowledge them, preventing duplicate injection in one consumer. Raw model transcripts, private prompts, credentials, local paths, and private model identity remain private.

## Artifacts

| Artifact | Authority | Visibility |
|---|---|---|
| attack plan | model | private until summarized |
| detector receipt | trusted runner | private |
| evidence digest | controller | public |
| public turn | template + allowlist | public |
| issue / PR / commit | GitHub | public |
| raw Pi trace | local owner | private |
| trace event stream | controller | public |

## Release gate

`terra hardening verify` executes the permanent attack corpus against one Git revision. A release is hardened only when every known product-defect regression is contained. Boundary clarifications are documented but do not fail the gate.

## Concurrency

Independent runs may execute concurrently, but each Terrarium process still owns one child. Parents can register existing run IDs in a durable group to preserve ordering and display grouped status/log summaries without hidden fan-out. Cancellation targets the child's Unix process group so ordinary descendants are torn down together. Strategy rounds are separated by a memory barrier. Fixes may be generated concurrently but merge serially; every stale fix must replay against the current head.

## Secure agent composition

```text
Pi (model transport; no built-in host tools)
  → run-scoped MCP: search + execute + finish
  → QuickJS code-mode orchestration
  → allowlisted Terrarium workspace capabilities
  → disposable secure-v1 Docker workspace
  → tests + diff + receipt + teardown
```

Terrarium remains the wrapper and capability broker; Pi remains the agent. Model credentials never enter Docker.

## Current limits

- secure-agent is proven on one dependency-free Node bug-fix fixture, not broad coding workloads yet.
- Docker/Lab provide the execution boundary; copy/worktree alone do not.
- GitHub required-check integration still needs a dedicated publisher identity.
- Public traces are safe event streams, never raw chain-of-thought.
