# Terrarium architecture

Terrarium's current core is durable execution and callbacks, with additive coordination and security profiles:

```text
terra "task"             one cooperative run (stable compatibility surface)
terra batch ...           explicit fan-out into independent ordinary runs
terra schedule replay ... deterministic terminal-semantics replay
terra secure "task"      hostile/untrusted secure-v1 validation profile
```

## Ordinary-run isolation

Parallel top-level runs keep separate metadata/logs and may execute concurrently. Each child receives a lineage-scoped capability policy: minimal/max-depth-one runs have no recursive spawn and self-only status/read; explicitly nested runs may see descendants but not siblings. MCP results require a run/task-correlated receipt, so process success is not automatically task success. See [CONCURRENCY_ISOLATION.md](./CONCURRENCY_ISOLATION.md).

## Core run lifecycle

One ordinary run owns one child process, metadata/log receipts, and at most one terminal result plus one deterministic terminal callback event. Terminal events are durably journaled before secondary in-process observers, even when no subscriber is online. Concrete late subscriptions replay matching journal entries without redelivering acknowledged events. Detached background runs feed observed process, cancellation, deadline, and receipt facts into the pure transition core in `src/run-machine.js`; the supervisor executes returned decisions using real processes, clocks, metadata, and the callback router. Versioned fixtures in `fixtures/run-schedules/` replay bounded classification facts only and never become a second persisted run record.

MCP callback subscriptions are a durable pull primitive and do not wake a host by themselves. The Pi extension is the host-delivery adapter: after a background spawn result it adds the concrete run ID to that session's durable subscription, claims only terminal events for those concrete runs, injects a visible follow-up with Pi's `triggerTurn: true`, and acknowledges only after injection succeeds. It does not subscribe Pi sessions as wildcard channel listeners; sibling Pi sessions in the same cwd/channel must not receive runs they did not spawn. Pi starts immediately if idle or drains the follow-up after its active turn; offline sessions replay subscribed runs on resume. Other MCP hosts must claim/ack callbacks or inspect status themselves.

Explicit batch fan-out in `src/batch.js` creates independent background runs, stores their run IDs in one durable group, and applies `all`, `allSettled`, `race`, `any`, or `quorum` join semantics. Winner-picking strategies cancel remaining ordinary runs through the same cancellation primitive.

## Historical campaign model

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

## Historical campaign state machine

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

Independent runs may execute concurrently; each run still owns one child and one receipt. Parents can register existing run IDs in a durable group, or explicitly use `terrarium_spawn_batch` to launch 1–32 jobs and create the group in one call. `concurrency` bounds simultaneous launches. Cancellation records durable intent, keeps the supervisor alive through launch handoff, and targets the child's Unix process group so descendants are torn down together. Strategy rounds are separated by a memory barrier. Fixes may be generated concurrently but merge serially; every stale fix must replay against the current head.

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

The public campaign/state-machine sections above document frozen historical provenance. See [CORE_PRODUCT_DECISION.md](./CORE_PRODUCT_DECISION.md); they are not the current product roadmap.

- secure-agent is proven on one dependency-free Node bug-fix fixture, not broad coding workloads yet.
- Docker/Lab provide the execution boundary; copy/worktree alone do not.
- GitHub required-check integration still needs a dedicated publisher identity.
- Public traces are safe event streams, never raw chain-of-thought.
