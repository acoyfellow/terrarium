# Core product decision

Terrarium's primary product is the durable execution and callback layer for bounded delegated work:

```text
one task → one child process → durable run → scoped progress/callback → correlated result
```

Core surfaces:

- stable CLI/Node/MCP spawn, status, and read;
- explicit batch fan-out into independent ordinary runs with all/allSettled/race/any/quorum joins and bounded concurrency;
- independent parallel runs represented by parent-owned groups;
- copy/worktree/secure workspace options;
- hard cancellation and process-tree teardown;
- lineage-scoped status/read/callback access;
- exact run/task result correlation;
- pure terminal transition semantics plus bounded, versioned timing-schedule replay;
- external callback queues with claim/ack/requeue/retention;
- runner independence and CI/headless use;
- thin Pi-native status/group/cancel presentation and terminal callback host delivery (idle turn trigger or queued follow-up; durable replay on session resume).

## Public breakout UI

Recommendation: **shelve and freeze** the public breakout campaign after preserving its existing evidence as a historical case study.

Reasons:

- it demonstrates useful security lessons but is no longer the clearest daily product value;
- illustrations and public-campaign machinery add substantial repository weight and conceptual overhead;
- the durable callback primitive changed actual usage more than the campaign UI;
- future development should not optimize attempt counts, imagery, or autonomous-healing theater.

Do not delete it until:

1. the 20-turn evidence is exported to a static historical artifact;
2. live Worker/KV/R2 resources have a documented retirement plan;
3. links from GitHub issues and README remain valid;
4. core package/runtime code no longer imports campaign-only modules.

Until then, treat the public system as maintenance-only legacy. No new campaign features or imagery should be added.

## Explicit non-goals

Terrarium will not become:

- an implicit multi-agent swarm (explicit bounded batch coordination is supported);
- a role-agent registry;
- a conversation memory system;
- a chain/workflow DSL;
- a replacement for pi-subagents' native orchestration UX.

Terrarium should compose with those systems as the durable leaf-job and callback substrate. `terrarium_spawn_batch` is intentionally a thin join/correlation layer over ordinary runs, not a role system, chain DSL, or hidden orchestration engine.
