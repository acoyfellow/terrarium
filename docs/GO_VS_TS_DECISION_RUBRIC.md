# Go vs TypeScript for the Terrarium core — decision rubric & evidence report

Status: **decision rubric (non-deploy)**. This document does not migrate, build, or
deploy anything. It defines a rigorous, falsifiable rubric for choosing Go vs
TypeScript for the durable-execution **kernel**, and it grades the choice against
five real recorded runs plus the operational truth Dane surfaced in production.
It must stay consistent with the agreed split in
[GO_CORE_MIGRATION.md](./GO_CORE_MIGRATION.md), the stable contract in
[CORE_PRODUCT_DECISION.md](./CORE_PRODUCT_DECISION.md), the runtime in
[ARCHITECTURE.md](./ARCHITECTURE.md), and the edge wake transport in
[PULSE.md](./PULSE.md).

## Scope of the decision

The choice is **only** about the durable-execution kernel: receipts, one-child
process supervision, batch/group join semantics, and background sweeps. It is **not**
about the adapters (CLI/Node/MCP/Pi extension) or Worker Pulse, which
[GO_CORE_MIGRATION.md](./GO_CORE_MIGRATION.md) already fixes as TypeScript. A choice
that requires moving the adapters or the Worker out of TypeScript is out of scope and
automatically fails criterion C7 below.

## The rubric

Each criterion is scored independently as **Go-favored**, **TS-favored**, or
**Neutral**, with the deciding evidence named. A criterion only counts if it is
*falsifiable*: there must exist an observation that would flip the score. Marketing
claims ("Go is faster") with no run behind them score Neutral by rule.

| ID | Criterion | What would make it Go-favored | What would make it TS-favored |
|----|-----------|-------------------------------|-------------------------------|
| C1 | Process-group control & teardown | Native Unix process-group + signal teardown is simpler/stronger in Go | Node `child_process` + tree-kill already meets every teardown case in tests |
| C2 | Decouple durable run lifetime from caller transport | A standalone Go binary keeps runs alive independent of the MCP/tool timeout | TS host can already detach runs so they outlive the caller |
| C3 | Concurrency predictability for batch/quorum joins | Go goroutines + channels make bounded-concurrency joins clearer & race-free | The TS join core is pure, single-threaded, and already race-free under test |
| C4 | Single shippable artifact for CI/headless hosts | One static Go binary removes the Node runtime dependency on CI/headless | npm install is acceptable on every target host today |
| C5 | Receipt / terminal-correlation correctness | Static typing prevents receipt-shape drift better | The TS receipt contract is already pinned by tests and a versioned machine |
| C6 | Pure transition-core parity & maintainability | Go port stays the single source of truth | Keeping two ports (TS + Go) in lockstep is pure cost with no behavior change |
| C7 | Boundary discipline (no adapter/Worker rewrite) | N/A — Go core respects the boundary | Any design forcing adapters/Worker off TS fails this outright |
| C8 | Migration risk vs. delivered user value now | A measured per-shard inert migration is low risk and unblocks C2/C4 | A full rewrite delays user-facing fixes the loop is shipping every iteration |

### Decision rule

1. Tally Go-favored vs TS-favored across C1–C8, each weighted equally.
2. **Any criterion is void unless it cites a real run or test** (the Neutral-by-rule
   clause). Hand-waved criteria do not move the tally.
3. C7 is a **gate**: a candidate that fails C7 is rejected regardless of tally.
4. If the tally is within one point, prefer the **lower-risk reversible** option
   (keep TS, port behind a stable boundary first) per C8.

This rule is deliberately biased toward reversibility: the kernel owns the
authoritative success proof, so an irreversible wrong call is expensive.

## Evidence: five real runs

These are recorded `receipts/product-loop/*.json` iterations. Each names concrete
child run IDs whose terminal results were verified by the parent loop. The decision
is graded against what these runs actually did, not against hypotheticals.

| # | Iteration receipt | Real child run cited | What it demonstrates |
|---|-------------------|----------------------|----------------------|
| R1 | `ph-20260626145000` | `ter_20260626135817039_z2u44k` | Callback subscriber denial normalized; targeted tests + smoke green |
| R2 | `ph-20260626150000` | `ter_20260626140220782_x4267h` | MCP batch timeout boundary + secure-workspace credential probe |
| R3 | `ph-20260626151000` | `ter_20260626141033054_8aj750` | `cleanupTimeoutMs` end-to-end behavior; batch/doctor/router tests green |
| R4 | `ph-20260626152000` | `ter_20260626141542538_89vumn` | Batch schema compatibility, receipts, callbacks, cancellation |
| R5 | `ph-20260626153000` | `ter_20260626142351341_7ogenu` | Batch compatibility + receipt contract + callback privacy; targeted tests green |

## Dane operational truth (the deciding signal)

Every one of R1–R5 records the **same** operational fact in its `commands` block:

> the `terrarium_spawn_batch` MCP call returns **`ok: false`** (the held-open MCP/tool
> call times out), **while the durable runs themselves complete**.

That is Dane's operational truth made concrete: the durable execution layer is
correct, but it is **coupled to the lifetime of the synchronous caller transport**.
The runs finish; the *caller* gives up first. This is exactly the failure C2 targets.

The same receipts also show the mitigation that already works in TypeScript: targeted
`node --test` suites and `product-loop:validate` + demo build/smoke all return
`ok: true` in every iteration. So the kernel logic is not the problem — the transport
coupling is.

### How the truth scores the rubric

| ID | Score | Evidence from the five runs |
|----|-------|------------------------------|
| C1 | Neutral | No run shows a teardown defect; tree-kill passes. Falsifiable but unfalsified. |
| C2 | **Go-favored** | R1–R5 all show batch MCP timeout while durable runs complete: decoupling run lifetime from the caller is the one repeated, real failure. |
| C3 | Neutral | Join semantics pass under test in every run; no observed race to favor Go. |
| C4 | **Go-favored** (weak) | A single binary helps headless/CI, but no run was blocked by Node install. |
| C5 | TS-favored | Receipt/callback correctness fixes (R1, R4, R5) landed and were pinned in TS with no shape drift. |
| C6 | TS-favored | The Go port already exists as a second source of truth (`internal/run`); lockstep is ongoing cost with no behavior delta in any run. |
| C7 | gate: pass | A bounded Go kernel respects the boundary; no run requires adapter/Worker rewrite. |
| C8 | TS-favored | The loop shipped real user-facing fixes every iteration in TS; a rewrite would have paused that. |

Tally: **2 Go-favored (C2, C4) vs 3 TS-favored (C5, C6, C8)**, C1/C3 Neutral,
C7 gate passed.

## Recommendation

**Do not rewrite the core in Go now. Pursue the bounded, inert Go-core port already
described in [GO_CORE_MIGRATION.md](./GO_CORE_MIGRATION.md), and let the C2 evidence
(batch MCP timeout vs. durable completion) drive the first behavior-changing shard:
decouple durable run lifetime from the synchronous caller transport.**

Rationale tied to the rule:

- The only repeated, real operational failure across five runs is **C2** (transport
  coupling), and C2 is Go-favored. But C2 can be satisfied by **detaching the run
  from the caller in either language**; it does not by itself require Go.
- TS wins the correctness/maintainability/value-now criteria (C5, C6, C8) on real
  evidence: every shipped fix in R1–R5 was delivered in TS and pinned by tests.
- The tally is within one point, so the decision rule selects the **lower-risk
  reversible** path: keep TS as the production kernel, continue the inert Go port
  behind the stable boundary, and prove C2's fix (detached run lifetime) before any
  irreversible move.

This keeps `terrarium_spawn`, `terrarium_status`, and `terrarium_read` stable, honors
the non-goals in [CORE_PRODUCT_DECISION.md](./CORE_PRODUCT_DECISION.md), and turns the
recurring batch-timeout truth into a concrete, testable next step instead of a
language religion.

## Non-goals

- This document does not migrate, build, or deploy a Go runtime.
- It does not re-decide the adapter/Worker boundary; that is fixed in
  [GO_CORE_MIGRATION.md](./GO_CORE_MIGRATION.md).
- It does not introduce any new product surface (memory, role registry, workflow DSL).
