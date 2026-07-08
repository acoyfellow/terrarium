# Chaos + Self-Heal + Speed Loop

Extends `.context/SELF_HEALING_TERRALOOP.md`. Same invariants, same evidence
labels, same reconciliation barrier, same safety rules. This loop's job is
NOT new product surface — it is to **continuously stress the live system,
detect regressions, auto-diagnose, and land bounded self-fixes**, while
chasing bounded latency/throughput gains. Every fix rides the existing
receipt/test/deploy discipline; nothing here weakens receipt authority.

## Two experimental focuses (run in parallel)

### A. Healing — chaos in, fix out

A chaos agent injects bounded, non-destructive faults against the live qual
surface (never prod-mutating beyond safe test fixtures), watches for any
invariant break or graceful-degradation gap, then drives the smallest
self-fix through builder/breaker + tests + reversible deploy.

Chaos menu (all bounded, all fail-closed-expected):
- burst concurrency past warm capacity (expect graceful backpressure / grace, never fake receipts)
- mid-run redeploy (expect reattach to terminal truth)
- deadline = floor while task is long (expect deadline-reached, no receipt)
- cancel at every phase: pre-admit-race, mid-boot, mid-model, post-terminal (expect intent precedence, idempotent)
- malformed/oversized/duplicate-idempotency requests (expect 400/413/deterministic)
- prompt-injection receipt forgery (expect correlation holds, summary-only influence)
- intermittent model 5xx amplification (expect bounded retry then fail-closed)
- R2 overflow + forced corrupt/missing ref (expect typed error, no terminal rewrite)
- callback backlog: claim-without-ack, requeue, dead-letter, replay (expect exactly-one canonical)

A chaos run that produces a NEW failure class is gold: it becomes a permanent
regression probe + a fix loop. A chaos run that the system survives becomes a
retained corpus entry so we never regress it silently.

### B. Speed — bounded latency/throughput gains, experimental

Baseline (PROVEN, 2026-07-06): warm single run admit→terminal ~13.5s;
10-wide concurrent 10/10 in ~91s after cold-start grace.

Experimental speed spikes (each must keep every invariant; measure before/after
on the same task, same surface, same window; reject any that trades correctness):
- container warm-pool / sleepAfter tuning to cut cold-boot on bursts
- Pi startup cost: trim the 168MB runtime footprint, lazy-load, or cache
- model route: streaming passthrough vs buffered; connection reuse
- admission→launch critical path: remove awaits, parallelize budget+DO
- log flush batching without weakening terminal durability
- poll cadence / alarm tuning to shorten terminal detection latency

A speed gain is accepted only with: a measured delta from ≥5 samples, no test
regression, no invariant weakened, and a reversible deploy + rollback target.

## Loop shape (one checkpoint question per turn)

1. Name the destination artifact (a new regression probe, or a measured speed delta).
2. Name the smallest uncertainty blocking it.
3. Run 2+ competing chaos/speed experiments when safe.
4. Capture bounded correlated receipts (run IDs, latencies, terminal states).
5. Parent-verifies the decisive fact directly (no child prose as proof).
6. Reconcile including failures; label every claim (PROVEN/LOCAL-ONLY/etc.).
7. If a fix is warranted: builder/breaker, tests, reversible deploy, re-measure.
8. Deposit exhaust: retained probe, corpus entry, or rejected hypothesis.

## Hard rules (inherited, non-negotiable)

- Only a verified TERRARIUM_RESULT (runId+taskFingerprint+nonce) is success.
- Chaos is bounded + non-destructive; qual surface for mutation, prod read/safe-test only.
- No prod/custom-domain deploy without capturing a rollback target first.
- Every deploy is reversible; health + auth fail-closed checked post-deploy.
- Preserve ~/.terrarium/workspaces and unrelated dirty work.
- A failed self-fix is exhaust, not a stop; move to the earliest invalid assumption.
- Two-stall rule: after two equivalent delegated stalls, parent runs the probe directly.
- No secrets/account-ids/transcripts in repo or public evidence.

## Speed gain ledger (append measured deltas only)

| date | change | metric | before | after | samples | invariant check | deploy/rollback |
|------|--------|--------|--------|-------|---------|-----------------|-----------------|
| 2026-07-06 | baseline measurement (no change) | admit->terminal warm | n/a | 8.2-12.5s cluster, 1 tail spike 59s/5 | 5 | n/a | n/a |

## Regression corpus (append survived-chaos + new-failure probes)

| id | chaos class | expected | first result | status | probe location |
|----|-------------|----------|--------------|--------|----------------|
| C1 | mid-boot cancel (cancel ~0.5s post-admit, container not warm) | cancelled/not-applicable/cancel-requested, no receipt | PASS (cancelled, intent precedence held pre-warm) | survived (retain) | live qual/prod /api/runs cancel |

## State

### Bootstrap
- Status: started.
- Baselines captured: warm single ~13.5s; 10-wide 10/10 ~91s (post grace).
- Housekeeping done: pruned ~15k stale run records (159M→102M), workspaces preserved.

### Round 1 reconciliation (2026-07-06)
- Chaos C1 (mid-boot cancel): PROVEN PASS — cancel ~0.5s post-admit before warm still settles cancelled/not-applicable/cancel-requested, no receipt. Retained as regression corpus C1.
- Speed baseline: PROVEN — warm admit->terminal clusters 8.2-12.5s over 5 samples with one 59s tail. The ~8s warm floor is dominated by Pi per-invocation startup + model round-trip; the tail is intermittent model 5xx/slowness (known P2).
- Decisive next uncertainty: how much of the ~8s floor is Pi process startup vs the single model call? That split decides whether a warm-pool / trimmed-runtime spike (focus B) is worth more than model-path streaming.
- Next smallest competing experiments: (1) instrument the runner to log wall time between TASK_RECEIVED and the model request vs model response (attributes the floor); (2) measure a trimmed Pi footprint boot time locally on amd64. Both are LOCAL-ONLY until re-proven live.
- Invariants: unchanged. No fix deployed this round (measurement only).
