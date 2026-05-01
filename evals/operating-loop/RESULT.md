# Operating loop eval result

Status: partial — fresh-agent resume executed, full receipt deferred.

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

## Fresh-agent resume (round 2)

A fresh Terrarium child agent resumed this eval with no chat history, only the artifacts above.

Terrarium child run:

```text
ter_20260501105011760_h0mai9
depth: 1/3
isolation: worktree
branch: terrarium/ter_20260501105011760_h0mai9
HEAD at start: 630910b (clean)
```

What the fresh agent did:

1. Read `evals/operating-loop/session-a-handoff.md` to recover objective.
2. Read `evals/operating-loop/runs/sidequest.json` to recover the prior recommendation.
3. Cross-checked recommendation against current repo state.
4. Ran `npm test`.
5. Updated this RESULT.md with the honest receipt.
6. Committed locally; did not push.

What the fresh agent did NOT do, and why:

The sidequest recommended editing `evals/wake-terrarium-dogfood/task.md` and adding `evals/wake-terrarium-dogfood/RESULT.md`. That directory does not exist in this commit (`630910b`). It existed in the dirty working tree at the time the sidequest ran (`1dee6ad` + untracked `evals/wake-terrarium-dogfood/`), but was not carried forward into the operating-loop preparation commit (`f5ab4d2`).

The fresh agent declined to recreate that directory from a stale recommendation. Implementing items 1–2 of the sidequest verbatim would invent files based on a snapshot of stdout, not on real prior content. That is exactly the failure mode `AGENT-OPERATING-LOOP.md` warns about under "Bad summaries become fake truth."

Items 3–4 of the sidequest (a README composition section and a worked example in `AGENT-OPERATING-LOOP.md`) could be written, but they would document a receipt that does not yet exist. Better to skip them than to ship docs that point at vapor.

Verification:

```sh
npm test
```

```text
# tests 5
# pass 5
# fail 0
```

(Existing tests; no new tests were added in this round.)

## Verdict

The operating loop has now been exercised in both directions:

- **Round 1 (prepared):** Parent recorded objective in Wake; spawned a Terrarium sidequest; Terrarium returned a useful but already-stale recommendation.
- **Round 2 (this round):** A fresh Terrarium child agent, with no chat context, resumed from disk artifacts, identified that part of the recommendation was no longer applicable, ran tests, and recorded an honest receipt instead of fabricating one.

What is now proven:

- Wake-style disk artifacts (`session-a-handoff.md`, `runs/sidequest.json`, this RESULT.md) are sufficient for a fresh agent to resume without chat history.
- The boundary held: Terrarium isolated execution in a worktree, did not touch Wake state, and produced summary + verification + follow-ups.
- A child agent can refuse to implement a stale recommendation. That is a feature, not a failure.

What is still not proven:

- A full receipt of `wake-terrarium-dogfood` composition (the original sidequest target).
- That a future fresh agent can resume from *this* RESULT.md and continue. (Will be tested by the next operating-loop run.)

## Follow-ups

- If the `wake-terrarium-dogfood` example is still wanted, redo the sidequest in the current commit so the recommendation matches the actual files on disk.
- Consider scoping `WAKE_HOME` explicitly when spawning Terrarium children for eval continuity, so the child can record into Wake instead of only into RESULT.md.

```text
disposable sessions, durable work, branchable context
```

Honest score this round: partial pass on the loop, full pass on the boundary, full pass on the "verify before trusting" rule.
