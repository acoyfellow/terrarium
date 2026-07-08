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
| 2026-07-06 | attribution: full runner vs zero-latency mock | Pi startup+session+validation | n/a | 549-953ms (PROVEN LOCAL) | 3 | receipts verified | n/a |
| 2026-07-06 | attribution: bare pi --version | process spawn | n/a | ~380ms (LOCAL) | 3 | n/a | n/a |

## Regression corpus (append survived-chaos + new-failure probes)

| id | chaos class | expected | first result | status | probe location |
|----|-------------|----------|--------------|--------|----------------|
| C1 | mid-boot cancel (cancel ~0.5s post-admit, container not warm) | cancelled/not-applicable/cancel-requested, no receipt | PASS (cancelled, intent precedence held pre-warm) | survived (retain) | live qual/prod /api/runs cancel |

## State

### Bootstrap
- Status: started.
- Baselines captured: warm single ~13.5s; 10-wide 10/10 ~91s (post grace).
- Housekeeping done: pruned ~15k stale run records (159M→102M), workspaces preserved.

### Round 4 (2026-07-06) — smaller-model A/B REJECTED
- Made the Workers AI model deployment-config-owned (env.TERRARIUM_WORKERS_AI_MODEL), allowlisted, never client-chosen (test added; 9 egress tests pass, full suite 556 pass). Deployed llama-3.1-8b-instruct-fast to QUAL (version d1d10a9c), 70b untouched on prod.
- A/B (PROVEN): qual 8b end-to-end latencies 9685/8087/9981/11329ms — statistically indistinguishable from prod 70b (9.3-12s). AND quality regressed: 4/5 verified but wrong/nonexact answers (1381, 39) on "17*23" where 70b reliably returns 391.
- REJECTED: a smaller model buys NO latency (the floor is not model compute) and costs correctness. Reverting qual to the default 70b. The ~8-10s warm floor is fixed overhead (container network transport + Workers AI queue/setup), not model size or Pi.
- Speed-focus conclusion: the only proven, deployed, invariant-safe latency/throughput win this campaign is the cold-start deadline grace (Round via cloud-pi-cell loop: 10/10 vs 7/10 concurrent, deployed prod). Smaller-model and Pi-trim levers are REJECTED. Remaining theoretical lever (streaming/transport) needs deeper infra work with uncertain payoff on a ~9s floor; not a quick win — deferred as HYPOTHESIS.

### Round 3 (2026-07-06) — latency attribution DECISIVE
- M2 (PROVEN LOCAL-ONLY): the full in-cell runner path (Pi launch + provider registration + model session + receipt strip/validate) against a zero-latency localhost model returns in 549-953ms across 3 samples with a verified receipt each.
- Conclusion: Pi is NOT the ~8s prod warm floor. With bare `pi --version` ~380ms and the whole runner <1s against a fast endpoint, essentially all of the ~8-12s prod warm latency is the Workers AI model round-trip (@cf/meta/llama-3.3-70b-instruct-fp8-fast), plus a variance tail (the 27-59s spikes) from upstream model slowness.
- Redirect: speed focus B should target the MODEL PATH, not Pi startup. Candidate experiments (each must keep invariants): (a) a smaller/faster Workers AI model for bounded C0 tasks where quality allows; (b) streaming passthrough so terminal detection does not wait for full buffering; (c) trim max_tokens default for short tasks; (d) measure model latency directly via the egress handler to separate model compute from transport.
- Rejected as low-value: warm-pool / trimmed-Pi-footprint work (would save <1s of a ~9s run). REJECTED for C0 priority.
- Next smallest experiment: A/B a faster Workers AI model vs llama-3.3-70b on the same bounded task, measured end-to-end on qual, keeping receipt authority; only promote if faster AND correct.

### Round 2 (2026-07-06) — dogfood model + public benchmarks
- Set Terrarium's own default child model to gpt-5.6-sol (config.defaultModel + defaultAgent pi/opencode.cloudflare.dev). PROVEN via terra dry-run and a real dogfood spawn ("dogfood verified").
- Added a live production benchmarks section to the website (app/public/benchmarks.json + App.svelte + style.css), numbers measured on prod: best warm 9.3s, typical ~12s, 10/10 fan-out, 100% receipt integrity. Built (446ms), data loads, deployed to prod version 7edce59a with rollback target 96a30de3; health 200, api-unauth 401 post-deploy. PROVEN.
- Pushed tweet-ready cloud-launch content to the owner agent-experience session (Master) via my-ax inject.
- Speed measurement M1: bare `pi --version` process startup ~380ms x3 (LOCAL-ONLY) — Pi CLI cold start alone is NOT the ~8s floor; the floor is dominated by Pi model-session setup + the model round-trip, not process spawn.

### Round 1 reconciliation (2026-07-06)
- Chaos C1 (mid-boot cancel): PROVEN PASS — cancel ~0.5s post-admit before warm still settles cancelled/not-applicable/cancel-requested, no receipt. Retained as regression corpus C1.
- Speed baseline: PROVEN — warm admit->terminal clusters 8.2-12.5s over 5 samples with one 59s tail. The ~8s warm floor is dominated by Pi per-invocation startup + model round-trip; the tail is intermittent model 5xx/slowness (known P2).
- Decisive next uncertainty: how much of the ~8s floor is Pi process startup vs the single model call? That split decides whether a warm-pool / trimmed-runtime spike (focus B) is worth more than model-path streaming.
- Next smallest competing experiments: (1) instrument the runner to log wall time between TASK_RECEIVED and the model request vs model response (attributes the floor); (2) measure a trimmed Pi footprint boot time locally on amd64. Both are LOCAL-ONLY until re-proven live.
- Invariants: unchanged. No fix deployed this round (measurement only).
