# Agent Operating Loop

This repo is exploring a simple idea:

```text
sessions become disposable
work becomes durable
context becomes branchable
```

The active chat session is not the system. It is only the current working attention.

The system is the loop around it.

## The layers

### Current session

The current agent session is working attention.

It should stay focused on the current objective, current plan, recent results, and immediate next step.

It should not carry every side quest, every old transcript, or every failed path inline.

### Wake

Wake is sessionless continuity.

It answers:

```text
what work is open, and how do we resume it without knowing the old session id?
```

Use Wake for:

- objective
- decisions
- attempts
- failures
- commands worth remembering
- changed files
- next step
- handoff for the next agent

Wake should record what a future agent needs, not everything that happened.

### Deja

Deja is durable memory.

It answers:

```text
what have we learned before that still matters?
```

Use Deja for:

- standing decisions
- durable user preferences
- repeated failure modes
- project facts that survive a single work thread
- pointers to important docs or receipts

Do not use Deja as raw transcript storage.

### Terrarium

Terrarium is execution isolation.

It answers:

```text
where should this messy task run so the parent stays clean?
```

Use Terrarium for:

- repo archaeology
- failing-test investigations
- design side quests
- log digging
- risky experiments
- bounded child-agent work

Terrarium should return summary, changed files, verification, and follow-ups.

Terrarium is not memory. It is not resume. It is not a process supervisor for everything.

### The Machine

The Machine is durable background orchestration.

It answers:

```text
what work should keep running when no one is watching?
```

Use The Machine for loops, scheduled work, and portfolio-level background runs.

## The loop

When a fresh agent starts:

1. **Resume work**

   Call Wake first when continuity matters.

   ```text
   wake_resume
   ```

   If there is no useful Wake handoff, continue from the user prompt.

2. **Recall durable memory only when needed**

   Use Deja when the task depends on prior decisions, user preferences, or known project facts.

   Do not pull Deja by habit. Pull it when it would prevent guessing.

3. **Plan the current step**

   Keep the parent context focused.

   The parent owns the plan and final decision.

4. **Branch messy work**

   Use Terrarium when a subtask would pollute the parent context.

   Good Terrarium tasks are bounded:

   - inspect this repo and report shape
   - diagnose this failing test, do not edit
   - compare these two implementations
   - propose a design, no file edits

5. **Verify before trusting**

   Treat child summaries and memories as claims.

   Prefer outputs with:

   - file paths
   - commands run
   - exit codes
   - log paths
   - changed files

6. **Record what matters**

   Use Wake during or at the end of work.

   Record:

   - decision
   - command
   - failure
   - changed file
   - next step

   Do not record every thought.

7. **Handoff**

   End with a Wake handoff when work should survive this session.

   The next agent should be able to continue from the handoff without reading the raw transcript.

## Boundaries

```text
Terrarium isolates execution.
Wake survives sessions.
Deja remembers durable facts.
The Machine runs background loops.
```

Do not make Terrarium a memory system.

Do not make Wake an orchestrator.

Do not make Deja a transcript dump.

Do not make The Machine the place for every small task.

## Failure modes

### Bad summaries become fake truth

Child results can be wrong.

Mitigation:

- keep raw logs linked
- require verification
- include file paths and commands

### Retrieval misses the important thing

The agent may forget to call Wake or Deja.

Mitigation:

- make `wake_resume` the obvious first tool
- keep Deja memories small and named
- store pointers to important docs

### Agent soup

Recursive delegation can become slow and confusing.

Mitigation:

- one Terrarium child per process
- bounded depth
- parent owns the decision

### Continuity drift

Wake can describe old state while the repo has moved on.

Mitigation:

- record git HEAD and dirty state
- check current repo state on resume

### Ceremony

The loop can become too much process.

Mitigation:

- use Wake for work that must survive
- use Terrarium for messy branches
- use Deja when prior memory matters
- otherwise just work

## Current doctrine

```text
Wake first when resuming.
Deja when guessing would be dangerous.
Terrarium when context would get polluted.
Wake handoff when the next agent should continue.
```

## One-line vision

```text
disposable sessions, durable work, branchable context
```
