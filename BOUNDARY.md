# Terrarium vs Wake

Terrarium and Wake both help with long-running agent work, but they solve different problems.

```text
Terrarium isolates execution.
Wake survives sessions.
```

They compose. They do not overlap.

## Terrarium

Terrarium is for agent side quests.

A parent agent can send one messy task to one fresh child process, then get back summary and logs. The child can read files, chase tests, inspect logs, or do design research without filling the parent's context.

Terrarium answers:

```text
Where should this task run?
```

Terrarium owns:

- spawning one child agent process
- depth guards
- child stdout/stderr logs
- run status
- parent/child lineage
- background child execution and polling

Terrarium must not own:

- cross-session continuity
- resume semantics
- project memory
- decisions / attempts / next-step journals
- handoff documents for future agents

A Terrarium run is finite. It starts, does one task, exits.

## Wake

Wake is for sessionless continuity.

It records the work state the next agent should see, even if the terminal died, the OpenCode session is forgotten, or a different agent picks up tomorrow.

Wake answers:

```text
What is the state of the work?
```

Wake owns:

- `wake resume`
- objective
- decisions
- attempts
- failures
- commands worth remembering
- changed files
- next step
- generated `HANDOFF.md`
- MCP tools for agents to discover continuity without a skill or system prompt

Wake must not own:

- spawning agents
- child process lifecycle
- depth / recursion guards
- stdout streaming
- execution orchestration

Wake is not a process spawner. It is a local work-state layer.

## Composition

The only valid integration is simple:

```text
Terrarium child may use Wake like any other agent.
```

Terrarium does not read Wake state. Wake does not know about Terrarium.

If a Terrarium child needs continuity, scope Wake explicitly:

```sh
WAKE_HOME=/path/to/child/.wake
```

Then the child can call:

```sh
wake start --objective "..."
wake note --kind decision --text "..."
wake handoff --print
```

or through MCP:

```text
wake_resume
wake_note
wake_handoff
wake_status
```

## Product test

Ask this when deciding where a feature belongs:

| Question | Product |
|---|---|
| Do we need a fresh child process? | Terrarium |
| Do we need to continue later without knowing the session id? | Wake |
| Do we need logs from a child run? | Terrarium |
| Do we need decisions and next steps for a future agent? | Wake |
| Do we need recursion/depth guardrails? | Terrarium |
| Do we need a handoff document? | Wake |

## Rule

Do not make Terrarium a memory system.

Do not make Wake an orchestrator.
