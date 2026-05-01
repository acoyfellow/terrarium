# Operating loop eval result

Status: prepared, not complete.

This eval exists to test the broader doctrine:

```text
disposable sessions, durable work, branchable context
```

After Wake became a standalone 0.0.1 repo, we started a real operating-loop eval but intentionally stopped before claiming full success.

## What happened

A parent session created a Wake run scoped to this eval:

```text
WAKE_HOME=evals/operating-loop/.wake
```

Wake run:

```text
wake_20260501_103314_run-full-operating-loop-eval-dis_9a6a
```

The parent recorded:

- objective
- boundary decision
- relevant files
- this eval task

Then the parent spawned a Terrarium sidequest to inspect the repo and recommend the single most useful patch for proving Wake + Terrarium composition.

Terrarium run:

```text
ter_20260501103314904_4z0nx3
```

Artifacts:

```text
evals/operating-loop/task.md
evals/operating-loop/session-a-handoff.md
evals/operating-loop/runs/sidequest.json
/Users/jcoeyman/.terrarium/runs/ter_20260501103314904_4z0nx3.log
```

## Sidequest recommendation

The child recommended finishing the existing `evals/wake-terrarium-dogfood/` receipt rather than inventing new source features.

Proposed patch:

1. Tighten `evals/wake-terrarium-dogfood/task.md` so the child uses Wake intentionally and returns a handoff path.
2. Add `evals/wake-terrarium-dogfood/RESULT.md` recording Terrarium run id, Wake run id, log paths, and verdict.
3. Add a short README composition section pointing to the receipt.
4. Add a worked example to `AGENT-OPERATING-LOOP.md`.

This is a good recommendation because it preserves boundaries:

```text
Terrarium passes environment and captures child logs.
Wake records work state.
Neither depends on the other.
```

## Verdict

This eval has not yet proven the full loop.

It has proven only that:

- Wake can hold the eval continuity state.
- Terrarium can produce a useful sidequest recommendation.
- The next step is clear enough for a fresh agent to resume from Wake.

Full success still requires a fresh agent, with no chat context, to:

1. run `wake --home evals/operating-loop/.wake resume`
2. read `evals/operating-loop/runs/sidequest.json`
3. implement the recommended patch
4. run tests
5. update this result
6. write a Wake handoff

## Why we stopped here

The clarification was that The Machine should remain a later progress database/orchestration layer. Wake, Deja, and Terrarium should be made useful standalone before being folded into The Machine.

So this result is deliberately honest:

```text
prepared, not complete
```

No fake victory.
