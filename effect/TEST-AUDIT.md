# Test audit against effect/SPEC.md

Scope: every `test/*.test.js` file (102). KEEP = re-express against the Effect 4 code. DROP = out of scope, old internals, docs text, or implementation detail the rewrite removes. Verdicts are based on test names and the assertions that carry the behaviour; where a file is mostly internals but holds a security property, it is KEEP and the assertions that matter are named.

| file | verdict | spec | reason |
|---|---|---|---|
| access-identity.test.js | KEEP | B1.1 | Signed Access JWT -> per-email owner; wrong aud/iss/exp/key refused; two users are two owners. |
| adaptive.test.js | DROP | campaign lab | Adaptive escape campaign. |
| basic.test.js | KEEP | B2.4 | Only the receipt-validation tests matter: column-zero marker, CR/Unicode separators, non-object JSON malformed, spoofing edge cases, independent of tail position. Prompt/agent-resolution tests are DROP. |
| batch.test.js | KEEP | B5.2 (batch) | Join strategies all/allSettled/race/any and job ceiling; re-express against HTTP-backed batch. Local concurrency window details DROP. |
| campaign-cli.test.js | DROP | campaign lab | Hypothesis prompt. |
| campaign-strategist.test.js | DROP | strategist | Strategist memory/novelty. |
| campaign-synth.test.js | DROP | campaign lab | Synthetic campaign generator. |
| child-prompt-contract.test.js | KEEP | B2.3, B2.4 | Container gets the task plus exactly one receipt template carrying the exact contract values. |
| cloud-accept-receipt.test.js | DROP | old internals | Local persistence of cloud admissions in the old client. |
| cloud-access-headers.test.js | DROP | old internals | Access service-token header plumbing replaced by `cloudflared access login` (B5.1). |
| cloud-admission-adapter.test.js | KEEP | B2.1, B2.8 | Admission 202 + contract, stable 4xx with no run started, per-owner concurrency budget freeing on terminal. capabilityEnvelope tests DROP. |
| cloud-api-batches.test.js | KEEP | B1.3, B2.8, B5.2 | 401 without auth, idempotency key required, concurrency capped at owner ceiling 8, unknown id 404. `/api/batches` endpoint itself is not on the SPEC (gap). |
| cloud-capability-callback-bridge.test.js | KEEP | B2.4, B3.1, B3.3 | Cloudbox bridge is out of scope, but keep: ok:true without matching receipt is not verified; wrong nonce mismatch; terminal callback exactly once across duplicate collect; cross-owner subscriber sees nothing. |
| cloud-client.test.js | DROP | old internals | Local/cloud routing, filesystem-dependency detection, cloudbox delegation. cloudList query building is minor B5.2 detail. |
| cloud-cloudbox-bridge.test.js | KEEP | B2.4, B3.1 | Cloudbox out of scope; keep only "ok:true without/mismatched TERRARIUM_RESULT is not verified" and single owner-scoped callback. |
| cloud-config-fallback.test.js | DROP | old internals | env/config.json fallback for the old client. |
| cloud-correctness-annotation.test.js | DROP | trust calibration and grading | Correctness annotation. |
| cloud-cross-producer-composition.test.js | DROP | trust calibration and grading | Cross-producer grade composition. |
| cloud-graded-endpoint.test.js | DROP | trust calibration and grading | `/graded` endpoint. |
| cloud-graded-receipt.test.js | DROP | trust calibration and grading | Graded receipt. |
| cloud-model-catalog.test.js | KEEP | B2.3 | Only "client-chosen upstream never used / no secret or endpoint leak". `/api/models` catalog itself is not on SPEC (gap). |
| cloud-model-egress.test.js | KEEP | B2.3 | Sandbox denies internet, allows exactly the model host; handler rejects unknown host/path/method; server-owned model; no credential vars in container. Retry/SSE/gateway details DROP. |
| cloud-model-enforce.test.js | DROP | model ladder | Alias routing to upstreams; only "never route a client raw upstream" overlaps B2.3, already covered by egress test. |
| cloud-model-gateway.test.js | KEEP | B2.3 | Keep "token attached server-side, client never supplies it; fails closed without endpoint/token". Custom sources DROP. |
| cloud-principal-budget.test.js | KEEP | B1.2, B1.3, B2.8 | Principal directory distinct tokens -> distinct owners, malformed directory fails closed, legacy control token never authorizes. Budget snapshot endpoint and PREVIOUS-token rotation are not on SPEC (gap). |
| cloud-production-c0.test.js | KEEP | B2.1, B2.5, B2.6, B3.1 | Most is DO/sandbox internals replaced by Workflows (DROP). Keep: idempotent admission same fingerprint, different task rejected, cancel yields partial logs without a receipt, deadline -> timeout terminal, callback re-emitted until committed. |
| cloud-pulse-principal.test.js | KEEP | B1.3, B3.3 | Client owner claims stripped; missing subscriber/unknown event identical 404s; fan-out only to same-owner subscribers; finish-before-subscribe respects isolation. Token rotation not on SPEC. |
| cloud-r2-log-retrieval.test.js | DROP | old internals | R2 log digest/seq mechanics. |
| cloud-receipt-artifact.test.js | DROP | trust calibration and grading | Content-addressed artifacts. |
| cloud-run-control-do.test.js | KEEP | B1.3, B2.6, B2.7 | Keep the HTTP tests: auth required, list only caller's runs, owner B never sees A, channel/status filter. Sandbox backend internals DROP. |
| cloud-run-index.test.js | KEEP | B2.7 | Per-principal isolation and recent-first order with filters. KV fail-soft internals DROP. |
| cloud-run-reconcile.test.js | DROP | local-process runner | Local reconciliation of cloud admissions. Terminal-not-overwritten idea covered by B2.5 elsewhere. |
| cloud-terrarium-local-e2e.test.js | KEEP | B2.4, B2.5, B2.6, B3.1 | Verified only on correlated receipt; missing/mismatch not done; exactly one callback on duplicate collect/cancel; status cross-owner fails closed; timeout/cancel terminals. |
| cloud-trust-calibration.test.js | DROP | trust calibration and grading | Calibration metadata. |
| cloud-trust-grade.test.js | DROP | trust calibration and grading | Grade lattice. |
| cloud-wasm-verifier.test.js | DROP | WASM verifier | WASM hash verifier. |
| cloud-web-session.test.js | DROP | old internals | GitHub OAuth cookie sessions, replaced by Access (B1.1). |
| cloudbox-adapter.test.js | DROP | cloudbox bridge / drift lab | Cloudbox diff parsing. |
| command-guard.test.js | DROP | old internals | CLI typo guard for old verbs. |
| concurrency-isolation.test.js | KEEP | B2.4 | Keep "verified receipt survives beyond a tail window" and "wrong or missing receipts are not successful". Local lineage/slot tests DROP. |
| concurrent-writer-warning.test.js | DROP | local-process runner | Shared-cwd co-writer warnings. |
| connect-pi.test.js | KEEP | B5.1 | Writes the Pi MCP entry without touching others and links the extension. |
| control-scenarios.test.js | DROP | hostile scenarios | Control-plane detectors. |
| control-worker.test.js | DROP | campaign lab | Lab control worker. |
| controller-auth.test.js | DROP | old internals | Old controller bearer check; constant-time owner auth is B1.2 and covered by principal tests. |
| demo-fanout.test.js | DROP | old internals | Demo script. |
| doctor-repair.test.js | DROP | old internals | Local doctor repair. |
| doctor.test.js | DROP | old internals | Local doctor diagnostics. |
| drift-lab.test.js | DROP | drift lab | Drift scoring. |
| effect-cloud-client.test.js | KEEP | B2.1, B5.2 | One idempotency key per admission, bearer auth, correlated receipt authority, different-fingerprint terminal stays ambiguous, pre-admission rejection creates no run. |
| ensure-terminal-callback.test.js | DROP | local-process runner | Local run-log callback routing. |
| epoch-runner.test.js | DROP | campaign lab | Campaign rounds. |
| failure-report.test.js | DROP | failure reports | Failure reports. |
| finding-pipeline.test.js | DROP | hostile scenarios | Escape finding pipeline. |
| fix-policy.test.js | DROP | healing CLI | Fix policy. |
| go-core-migration-docs.test.js | DROP | Go migration docs | Doc text. |
| go-vs-ts-decision-rubric.test.js | DROP | Go migration docs | Doc text and receipts on disk. |
| go-vs-ts-evidence-shard-a.test.js | DROP | Go migration docs | Go/JS agreement. |
| go-vs-ts-replay-conformance-shard-p.test.js | DROP | Go migration docs | Go/TS replay. |
| groups.test.js | DROP | old internals | Local groups; group truth reconstruction not on SPEC. |
| healing-cli.test.js | DROP | healing CLI | Healing loop. |
| home-isolation.test.js | DROP | local-process runner | TERRARIUM_HOME isolation. |
| host-capacity.test.js | DROP | old internals | Orphaned pi reaping on host. |
| hostile.test.js | DROP | hostile scenarios | Hostile registry. |
| issue-18-callback-acks.test.js | KEEP | B3.2 | A malformed ack does not hide the event. Doctor-count half DROP. |
| lab.test.js | DROP | campaign lab | Lab payloads. |
| list-runs.test.js | DROP | local-process runner | Local run listing; stale accepted callback is local-runner concern. |
| loop-decide.test.js | KEEP | B4.1, B4.2, B4.3 | Contract validation, harness lines ignored, stop passed/exhausted, replay determinism. |
| mcp_concise.test.js | DROP | old internals | Concise envelope shaping for old local MCP output. |
| mcp_scope.test.js | KEEP | B3.3 | Callback claim/ack/subscriber mutations deny other owners indistinguishably. Child-lineage scope tests DROP (no recursive spawn in SPEC); stable tool surface partly B5.2. |
| mcp-byid-routing.test.js | DROP | local-process runner | Local vs cloud id routing. |
| mcp-local-routing.test.js | DROP | local-process runner | ALLOW_LOCAL routing. |
| model-ladder-escalate.test.js | DROP | model ladder | Model ladder. |
| model-ladder.test.js | DROP | model ladder | Model ladder. |
| model-preflight.test.js | DROP | local-process runner | Local Pi provider preflight. |
| parameterized-probes.test.js | DROP | hostile scenarios | Probes. |
| pi-extension-callback-shape.test.js | KEEP | B5.3 | Extension recognises spawn tool names and the claim response shape. |
| pi-extension.test.js | KEEP | B5.3 | Wakes exactly once; failed send requeues; poison callback bounded; survives restart. |
| product-loop.test.js | DROP | public ledger and traces | Public campaign receipts. |
| proof-chain-docs.test.js | DROP | docs text | README wording. |
| prune-child-claims.test.js | DROP | local-process runner | Child claim files. |
| public-ledger.test.js | DROP | public ledger and traces | Public ledger redaction. |
| pulse-assets-topology.test.js | KEEP | B1.3 | Gated routes reach the Worker (401) instead of SPA fallback; re-express as "every API route is owner-gated". wrangler-jsonc parsing details DROP. |
| pulse-do.test.js | KEEP | B3.1, B3.2, B3.3 | Dedup of duplicate emit, claim/ack idempotent, inflight requeue, cross-owner cannot claim/ack. Private-field stripping and quarantine are extras. |
| pulse-e2e.test.js | KEEP | B1.3, B3.2, B3.3 | Full claim/ack, dedup, client owner claims ignored, cross-owner generic 404, fail-closed auth. |
| pulse-principal-directory.test.js | KEEP | B1.2 | Directory token authenticates as that owner; legacy tokens refused. |
| pulse-worker-e2e.test.js | KEEP | B1.3, B3.2 | 401 on every gated route, claim/ack then second claim empty, client owner claims ignored. CORS tests not on SPEC. |
| replay-gate.test.js | DROP | healing CLI | Autonomous merge gate. |
| router.test.js | KEEP | B3.1, B3.2, B3.3 | Route/dedupe/claim/ack exactly once; stale inflight requeued; owner-scoped subscriptions. Prune/unsubscribe/wildcard internals DROP. |
| run-machine.test.js | KEEP | B2.4, B2.5, B3.1 | Cancel vs completion wins once; late verified receipt after cancel ignored; exit never trusted without receipt; deadline; one terminal callback. Supervisor-recovery tests DROP. |
| sandbox.test.js | DROP | hostile scenarios | Docker escape sandbox. |
| scenario-registry.test.js | DROP | campaign lab | Scenario registry. |
| secure-agent.test.js | DROP | old internals | secure-v1 local Docker agent and doc text. |
| secure-workspace.test.js | DROP | worktree capture | Disposable local workspace. |
| secure.test.js | DROP | old internals | secure-v1 local Docker. |
| spawn-git-timeout.test.js | DROP | worktree capture | git subprocess timeout. |
| status-format.test.js | DROP | old internals | CLI text formatting. |
| task-proof.test.js | DROP | old internals | Host-run proof commands; local-runner feature. Its first test usefully documents that a fabricated receipt passes contract checks (see gaps). |
| terrarium-runner-ca-preflight.test.js | DROP | old internals | OpenCode CA preflight. |
| terrarium-runner-receipt.test.js | KEEP | B2.4 | Runner scripts emit at most one correctly shaped receipt line. |
| trace-events.test.js | DROP | public ledger and traces | Trace redaction. |
| worktree-capture.test.js | DROP | worktree capture | Worktree capture. |

## Counts

- Files: 102
- KEEP: 33
- DROP: 69

## KEEP behaviour not yet on the SPEC list (raise to user)

1. Batch HTTP API (`POST /api/batches`, `GET` batch, aggregate status, maxConcurrency capped at owner ceiling) — cloud-api-batches. B5.2 mentions batch in MCP only.
2. Token rotation: CURRENT and PREVIOUS principal tokens both authorize — cloud-principal-budget, cloud-pulse-principal, pulse-e2e. B1.2 has a single token per id.
3. Legacy/shared tokens (control token, PULSE_TOKEN) must never authorize — not stated as a negative in B1.
4. Anti-enumeration: unknown subscriber, unknown event and other-owner resources all return identical generic 404 — B2.6 says it for runs only, not callbacks (B3.3).
5. Client-supplied owner fields in request bodies are ignored — pulse tests.
6. Callback deduplication by eventId on duplicate emit, and finish-before-subscribe replay — B3.1 implies it but does not say replay.
7. Poison-callback cap / quarantine after N delivery attempts (router, pulse-do, pi-extension).
8. Private fields stripped from callback payloads.
9. Model catalog `GET /api/models` and per-run model pin by alias.
10. Budget snapshot endpoint `GET /api/runs/budget/snapshot`.
11. Admission validation: oversized task rejected with stable 4xx and no run started (B2.1 does not cap task size).
12. Model route hardening: fixed server model, exact host/path/method allowlist, 3021 backpressure -> 429, transient 5xx retry.
13. A fabricated but well-formed receipt passes verification (task-proof): SPEC should state that `verified` means correlated, not that the work is correct.
14. CORS / OPTIONS preflight on gated routes.

## Tests believed not meaningful

- controller-auth.test.js: three asserts on a string compare; passes with a non-constant-time `===` and does not check the property B1.2 cares about.
- epoch-runner.test.js: two asserts on a pure reshaping helper; out of scope anyway.
- go-core-migration-docs.test.js, go-vs-ts-decision-rubric.test.js, proof-chain-docs.test.js, secure-agent.test.js (doc half): regex over markdown; pass regardless of code behaviour.
- go-vs-ts-* shards: Go halves skip when `go` is absent, so they pass vacuously on most machines.
- pulse-assets-topology.test.js (regression-guard half): checks wrangler.jsonc text, not runtime routing.
- cloud-correctness-annotation / cloud-trust-calibration "advisory, never claims authority words" tests: string-absence checks that pass for any output lacking those words.
- mcp_concise.test.js "concise is meaningfully smaller than verbose": a size comparison that holds for nearly any projection.
- cloud-run-index.test.js "never throws / put failure swallowed": would pass with a no-op implementation.
