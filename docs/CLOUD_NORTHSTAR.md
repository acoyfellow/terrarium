# Cloud Terrarium Northstar

## Northstar

Terrarium is cloud infrastructure for bounded delegated work at massive fanout.

A user can submit one bounded task or a large fanout request to cloud Terrarium and get durable logs, terminal wakeups, and reconstructable receipts for every unit of work.

## Day-one invariant

The first use case remains the irreducible product primitive:

> One offloaded task submitted to cloud Terrarium, with one per-run receipt, must work as simply and reliably as it did day one — with no batch, fanout, or cloud-scaling concept required to use it.

Precedence: in every doc, demo, and external claim, the day-one one-off invariant outranks the large-fanout headline. The headline is never shown without the per-task receipt framing.

## Product focus

Initial internal research confirms "cloud subagents" and "multi-agent orchestration" already exist as active Cloudflare directions. Initial external research confirms async batches and workflow fanout are also established product categories. Terrarium's product focus is therefore narrower and lower-level: bounded task admission, execution cells, receipts, and terminal wakeups at fanout.

- Cloud is the product substrate.
- Local is a development/conformance harness and compatibility shim, not the scaling target.
- The day-one one-off task executes on cloud Terrarium; local runs the same primitive only as a conformance/compat check, never as the product answer to "run this one task for me."
- We build one product with one primitive and one admission path: cloud Terrarium. Single-run is not a second mode — it is `N=1` of the same path.
- Local fixes are allowed when they protect tests, receipts, the day-one primitive, or cloud proof work. Local bloat is not a product goal.

## Parallel-first operating model

Terrarium thinks in parallel first, not sequential first.

- Every planning step asks what can split into independent bounded tasks.
- Independent research/review/build work fans out concurrently.
- The parent verifies and reduces results after terminal callbacks arrive.
- Sequential work is used only when a dependency is real and named.
- Cloud Terrarium is designed around admission-controlled windows over many ordinary run cells, not a serial queue with a batch label.

This does not weaken the one-off use case:

```text
one task works because one cell works;
large fanout works because many one-cell primitives can run under bounded parallel admission.
```

## Stable primitive

```text
one bounded task
-> one execution cell
-> one correlated receipt
-> one durable terminal wake event
```

A large fanout call admits, schedules, observes, and aggregates many ordinary primitives under bounded parallel admission. The aggregate is not proof; the per-task receipt is proof.

## Non-goals

Terrarium is not:

- a persistent agent session framework;
- a specialist-agent router or Agent Fleet;
- a Lee/Think sub-agent product;
- a workflow DSL;
- a replacement for Agents SDK or Sandbox SDK.

Terrarium can use those substrates or integrate with them, but its own primitive is bounded delegated work with receipts.

## Honest large-fanout wording

Do **not** claim:

```text
Spawn 120,000 agents in one call.
```

That overclaims concurrency, overloads "spawn," and blurs agents with bounded tasks.

Acceptable design-target wording until measured proof exists:

> Submit up to 120,000 bounded tasks in a single request. Each becomes an independent execution cell with its own durable, reconstructable receipt and terminal wake event.

Precise caveat:

> One request admits the tasks and returns a durable group receipt; admission and scheduling happen under quota and backpressure. This is not a claim of 120,000 simultaneous executions. Success is defined per task by its verified receipt, not by the aggregate. Delivery of wake events is at-least-once with dedup; a wake means finished, not succeeded.

Until a scale receipt exists, use:

```text
Design target: 120,000 tasks/submission. Demonstrated: [N] in [proof run <id>].
```

## Architecture sketch

```text
client / parent
  -> Admission API: POST /runs, POST /batches
  -> RunIndexStore: D1-like run and batch metadata
  -> Queue: admission/backpressure/concurrency windows
  -> TerrariumRunCell: Durable Object per runId; authoritative per-run truth
  -> ExecutionBackend: Sandbox/Containers first
  -> LogArtifactStore: R2-like logs/artifacts/receipts
  -> Pulse: durable terminal wake, claim/ack/replay
  -> BatchController: aggregate terminal facts only; never proof authority
```

Two entry points, one primitive:

- `/runs`: one cell, one receipt, one wake.
- `/batches`: N ordinary cells admitted through a bounded window; N receipts, N wakes, aggregate status.

The fanout path must construct the identical per-run cell as the one-off path.

## Next implementation slice

Build **C0 Cloud Run Cell Parity** first.

Goal:

```text
POST /runs admits one bounded task to a cloud Terrarium run cell and returns the same reconstructable receipt semantics as local Terrarium.
```

Scope:

- one-off `/runs` only;
- one `TerrariumRunCell` Durable Object per `runId`;
- one execution backend adapter, preferably Sandbox/Containers;
- persisted `executionRef`, cancel intent, deadline intent, log refs, and receipt refs;
- Pulse terminal wake emission after terminal commit;
- status/read/cancel APIs for one run;
- tests for receipt verified/missing/mismatch, timeout, cancel, partial logs, duplicate collect, and commit-before-wake reconcile.

Non-scope:

- no 120,000 claim;
- no public fanout API yet;
- no Dynamic Workflows parent;
- no Agent Fleet routing;
- no persistent chat/session memory;
- no deploy unless explicitly requested.

Why first:

```text
`N=1` is the product invariant. If the cloud one-off path does not meet the invariant, fanout has no validated per-task primitive.
```

Exit criteria:

- cloud C0 test suite passes for the one-off run cell;
- the one-off cloud receipt can be reconstructed without trusting child prose;
- terminal wake is emitted exactly once and replayable;
- local remains only a conformance harness for the same primitive.

After C0, build C1 bounded fanout by composing N ordinary C0 cells under a `maxConcurrency` window.

## Proof gates before public scale claims

1. Day-one gate: one-off `/runs` works on the cloud backend with receipt reconstruction, timeout, cancel, partial logs, and wake replay.
2. Parity gate: a fanout-created cell and a one-off cell are the same run-cell shape.
3. Bounded-fanout gate: measured fanouts prove peak live cells never exceed `maxConcurrency` and no terminal wakes/receipts are lost.
4. Honesty gate: every scale number is published as measured characterization, not instant concurrency.
5. Failure-truth gate: `inconclusive`, `failed`, and `cancelled` are never rolled up as success.
6. Receipt gate: every terminal run has a reconstructable per-run receipt; batch receipts only reference child receipts.
