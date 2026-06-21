# Terrarium and pi-subagents

Reviewed against `pi-subagents` 0.30.0 on 2026-06-21. The projects should not have identical scope.

| Surface | Terrarium | pi-subagents | Current leader |
|---|---|---|---|
| Single bounded child | Runner-independent process with durable run/task receipt | Pi-native focused child session | Different strengths |
| Parallel launch | Parent launches independent runs, then registers a durable group; no hidden fan-out | One native `tasks[]`/`parallel` call with concurrency | **pi-subagents** |
| Group status | Durable ordered group, concise per-run state/logs/attention/cancel plus native Pi group widget/command | Rich grouped chain/parallel status tree | Match for status; pi-subagents richer chain rendering |
| Progress | Durable heartbeat/output activity/idle/attention plus native Pi active-run widget and completion messages | Native live Pi widget and per-agent progress | Match for core progress; pi-subagents richer animation/detail |
| Cancellation | Hard process-group termination, durable cancelled receipt, group cancel | Soft interrupt/pause plus nested targeting/resume | Different: Terrarium hard stop; pi-subagents recovery |
| Resume/follow-up | Start another run; no conversation resurrection | Live intercom follow-up and session revival | **pi-subagents** |
| Context modes | Fresh ephemeral process prompt; explicit task contract | Fresh or real parent-session fork | **pi-subagents** for Pi |
| Tool scoping | Machine-enforced spawn/status/read lineage; secure-agent code-mode profile | Per-agent builtin/MCP/extension allowlists and child-safe fanout | Different; Terrarium stronger cross-run isolation |
| Workspace isolation | none/copy/worktree plus experimental secure-v1 Docker | optional per-task git worktree | **Terrarium** |
| Result correlation | nonce + run ID + task fingerprint; exit zero is insufficient | structured output schema and acceptance levels | Different, complementary |
| Callbacks | External scoped durable queue, deterministic IDs, claim/ack/requeue/prune | Pi-native result watcher, notifications, optional intercom | Terrarium external; pi-subagents native UX |
| Duplicate suppression | deterministic callback IDs, atomic queue claims | completionSeen/result coalescing | Match |
| Durability | JSON metadata/logs/patches/groups/journal/mailboxes usable outside Pi | Pi session + async run artifacts | **Terrarium** outside Pi |
| Runner support | Pi, OpenCode, custom commands, Node API, CLI, MCP, CI | Pi only | **Terrarium** |
| Chains/dynamic fanout | Intentionally out of scope; one child per process | core feature with static/dynamic fanout | **pi-subagents** |
| Agent roles/config | Caller supplies command/prompt/profile | built-in roles, overrides, skills, fallbacks | **pi-subagents** |
| Diagnostics | top-level doctor for runs/storage/callbacks/claims | `/subagents-doctor` for Pi runtime and intercom | Match within scope |

## Product boundary

Use pi-subagents when the desired product is native Pi multi-agent orchestration, chains, forked conversations, review loops, or interactive clarification.

Use Terrarium when delegated work must be durable outside Pi, observable by external systems, correlated to an exact task, isolated in a copy/worktree/container, executable by mixed runners, or integrated with CI and callback consumers.

## Pi-native layer now included

Terrarium's package extension provides:

- compact active-run and active-group widget;
- concise completion messages from the durable claimed/acknowledged callback queue;
- `/terrarium-status`, `/terrarium-groups`, and `/terrarium-cancel` commands;
- no extension/widget registration inside spawned children.

## What Terrarium should not copy

- Agent-role management.
- Hidden fan-out inside one Terrarium process.
- Chains or dynamic orchestration DSLs.
- Parent-session forking/resume semantics.
- A second intercom/memory system.

Those features are already better served by pi-subagents and would blur Terrarium's one-child durable-execution contract.

## Honest conclusion

Terrarium is not better in every way. pi-subagents is clearly better for Pi-native orchestration, parallel launch ergonomics, forked context, resume, and chain UX. Terrarium is sharper as a runner-independent durable execution/callback substrate. The justified Pi-native presentation layer now exists. Remaining pi-subagents advantages—parallel launch, chains, fork/resume, role agents, and clarification UI—are intentionally not Terrarium scope.
