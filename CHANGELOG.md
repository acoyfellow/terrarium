# Changelog

Succinct, product-facing changes to Terrarium. This is not a full commit log; it records notable behavior, API, safety, and public-site changes.

## Unreleased

### Pi extension: a missing-subscriber session start and one poison callback can no longer wedge follow-up delivery

- **The session-start crash.** On every `session_start` the Pi host extension ran `requeueInflightEvents` before any durable subscriber existed. For a brand-new session that had never spawned a run, `getSubscriber` threw `ENOENT`, the throw propagated out of the `session_start` handler, and the refresh `setInterval` was never armed — leaving the runs widget and *all* callback-triggered follow-ups dead for the entire session. The same `ENOENT` also surfaced through `claimMailboxEvents` inside `refresh`.
- **The poison-event strand.** `refresh` claimed a batch of terminal callbacks and delivered them in a loop: `pi.sendMessage(...)` then `acknowledgeMailboxEvent(...)`. A single throwing `sendMessage` (transient Pi delivery failure, or a genuinely poison event) aborted the whole loop, so every *later-claimed* sibling callback in that same batch stayed `inflight` and was never delivered — and because `requeueInflightEvents` only ran at `session_start`, those siblings stayed stuck inflight for the rest of the session instead of being retried by the 1.5s refresh.
- **The fix.** Router mailbox-draining ops (`claimMailboxEvents`, `requeueInflightEvents`) now resolve the subscriber through a new `resolveOptionalSubscriber` helper: a never-registered subscriber is treated as an empty mailbox (graceful no-op) rather than an `ENOENT`, while the owner access-control check is preserved verbatim for subscribers that *do* exist. In the Pi extension, each callback delivery is isolated — a throwing `sendMessage` requeues *only that event's id* back to pending (via the new `eventIds` allowlist on `requeueInflightEvents`, `olderThanMs: 0`) so the next refresh retries it, while the surviving siblings in the same batch are still delivered. The receipt/ack contract is unchanged: an event is acked only after Pi accepts it.
- New `eventIds` allowlist parameter on `requeueInflightEvents` requeues a precise inflight subset without disturbing siblings the consumer still holds in-memory. Tests added: `test/pi-extension.test.js` (fresh-session no-crash, single throwing send requeue+redelivery, one-poison-doesn't-strand-its-sibling) and `test/router.test.js` (`eventIds` filter requeues only the named event and leaves siblings inflight). No deploy.

### Doctor: self-heal repair receipts can prove they reconciled (residual evidence)

- **The gap.** `executeRepairPlan` reported *what it ran* (`applied`/`skipped` counts) but never *whether the diagnosed condition actually cleared*. An operator reading a repair receipt with `ok: true` had a claim that recover/requeue/prune executed — not evidence that the stale callbacks, missing terminal events, or dead child-claims were gone. A callback that re-staled, or a slot a concurrent run re-took, would still read as a clean repair.
- **The fix.** `executeRepairPlan({ verify: true })` (on an applied, non-dry run) re-runs `diagnoseTerrarium` after the repair and attaches a `residual` evidence block. For each self-healing kind that was in the plan it records `{ kind, counter, before, after, cleared }` mapping the kind to its diagnosis counter (`missingTerminalCallbacks` / `staleInflightCallbacks` / `staleChildClaims`), with `before` taken from the pre-repair baseline and `after` from the re-diagnosis. `residual.verified` is true only when every checked counter reached zero, so a repair that *ran* but did not *reconcile* is now visible instead of masquerading as success.
- **Scope.** Verification only checks the mechanically-safe kinds the repair actually drove; judgement/quarantine steps are never auto-run and so are never claimed as cleared. A dry run never verifies (nothing changed to re-measure), keeping the default path free of an extra diagnosis pass. Exposed on the CLI as `terra doctor --repair --apply --verify`; `terrarium_doctor` over MCP stays read-only. Tests added in `test/doctor-repair.test.js`; README and COMPATIBILITY updated.

### Batch: large-batch preflight gives an actionable suggested concurrency instead of a bare rejection

- Lifting the batch ceiling to 256 made the "over 32 jobs requires an explicit `concurrency` bound" rule the most common large-batch stumble, but the failure was only a thrown string buried inside `spawnBatch` — callers had to launch (or read source) to discover both *that* a bound was required and *what value* to use.
- New pure, side-effect-free `validateBatchShape` (exported from `src/batch.js`) returns a structured verdict — `{ ok, code, error, jobCount, requiresConcurrency, suggestedConcurrency, effectiveConcurrency }` — so the batch contract is inspectable *before* any child launches. A large batch missing its bound now carries `code: "missing-concurrency"` and a concrete `suggestedConcurrency` (default `SUGGESTED_LARGE_BATCH_CONCURRENCY = 8`, capped at the job count), and the error string itself ends with `try concurrency: 8`.
- `spawnBatch` now validates *through* `validateBatchShape` and throws `verdict.error`, so the inspectable verdict and the thrown message are single-sourced and can never drift. All existing validation messages (job-count, strategy, quorum, concurrency, cleanupTimeoutMs) are preserved verbatim.
- The `terrarium_spawn_batch` MCP handler preflights the shape and returns the structured verdict as a clean failure response at `phase: "preflight"` — with `code` and `suggestedConcurrency` — instead of surfacing only a deep thrown string. The MCP `concurrency` schema description now notes the preflight rejection. No runs are launched on a rejected preflight.
- New `validateBatchShape` unit test in `test/batch.test.js` asserts the suggestion, the per-error codes, the `effectiveConcurrency` echo, and the single-source guarantee (`verdict.error` is exactly what `spawnBatch` throws). `CONCURRENCY_ISOLATION` and `COMPATIBILITY` docs updated. No deploy.

### Operational truth: the Go run-machine port had the same terminated-run-is-verified lie the JS fix already closed

- **The lie.** The JS "Win 10" fix established that a run terminated by cancellation or deadline produces no trusted completion, collapsing `taskContractStatus` to `not-applicable`. That changelog asserted the Go side was sound because *the Go runner* (`go/runner`) has no `taskContractStatus` field — true, but it overlooked the Go *run-machine* port (`internal/run/machine.go`), which faithfully ports `src/run-machine.js` and **does** carry `TaskContractStatus`/`TaskResultSummary`. Its `cancel-requested` and `deadline-reached` finalizers used a `contractOrNA()` helper that only normalized to `not-applicable` when the receipt was still `pending`. If a verified `ReceiptObserved` landed *before* the terminating intent (or before the child exit committed the terminal record), the cancelled/deadlined record settled with `status: cancelled`/`failed`, `ok: false`, **but `taskContractStatus: "verified"`** — the exact lie, reproduced in Go. The leaked summary path was identical.
- **The fix.** The Go `cancel-requested` and `deadline-reached` finalizers now hard-code `TaskContractStatus: "not-applicable"` and never emit a `TaskResultSummary`, independent of receipt arrival order — matching the JS run-machine fix and the orphan terminal convention. The cancel-vs-completion *status* boundary is unchanged: a clean `ChildExited → ReceiptObserved → CancelRequested` still finalizes terminal before the cancel arrives and ignores it as late input.
- Regression tests added in `internal/run/machine_test.go`: `cancel → receipt → exit`, `receipt → cancel → exit`, and `receipt → deadline → exit` orderings all assert `not-applicable` and an empty `taskResultSummary`; the existing `TestCancelWinsOverVerifiedReceipt`/`TestDeadlineWins` cases were strengthened to pin the contract field they previously left unchecked (which is why the bug shipped). Full `go test ./...` green. No deploy.

### Wow hardening loop: wins 7–10

- **Win 7 — large bounded batches:** `terrarium_spawn_batch` and durable groups now accept up to 256 queued jobs, while requiring explicit `concurrency` above 32 so active children stay bounded.
- **Win 8 — doctor self-heal dry-run/apply:** `terra doctor --repair` now builds an executable repair summary and `--apply` can run the mechanically safe recover/requeue/prune subset; judgement-heavy steps remain skipped for an operator.
- **Win 9 — poison callback visibility:** filesystem and Pulse requeue now track `deliveryAttempts` and report `maxAttempts`, making repeatedly claimed-but-unacked callback events visible instead of silently looping forever.
- **Win 10 — cancelled/deadlined receipt truth:** receipts observed before cancellation or deadline no longer survive as `verified` task-contract status on cancelled/deadlined terminal records.

### Operational truth: a terminated run can no longer be reconstructed as a verified task success

- **The lie.** A child could emit a valid `TERRARIUM_RESULT` receipt (classifying `taskContractStatus: "verified"`) while still running, and *then* be cancelled or hit its deadline before the process actually exited. The run-machine and the dead-supervisor cancel-recovery paths preserved a non-`pending` receipt verbatim, so the terminal record settled as `status: "cancelled"` / `status: "failed"` with `ok: false` **but retained `taskContractStatus: "verified"`**. Every consumer that reconstructs operational truth from that field — durable group roll-ups (`getRunGroupStatus`), the Pi extension surface, and the mcp retry classifier — would read a terminated run as a successful task receipt.
- **The fix.** A run terminated by cancellation or deadline is treated as having produced no trusted completion: the run-machine's `cancel-requested` and `deadline-reached` finalizers now collapse the contract status to `not-applicable` regardless of receipt arrival order, matching the existing orphan terminal convention. The two `core.js` dead-supervisor recovery sites (`reconcileRun` early-cancel branch and `cancelRun` settle branch) likewise normalize both `pending` *and* `verified` to `not-applicable`. The cancel-versus-completion *status* boundary is unchanged — a clean `ChildExited → ReceiptObserved → CancelRequested` still finalizes `done` because cancellation arrives after terminal commit and is ignored as late.
- **Go runner is sound for this class.** The experimental Go runner's `Result` models only process `status` (done/cancelled/timeout/error) and has no `taskContractStatus` field, so a terminated Go run cannot carry a stale verified receipt; the receipt-survives-termination bug is purely in the JS run-machine/core and is fully scoped there.
- Regression tests added in `test/run-machine.test.js`: pure-machine `receipt → cancel → exit` and `receipt → deadline → exit` orderings assert `not-applicable` (and no `taskResultSummary`), plus a core-layer dead-supervisor recovery test that seeds `taskContractStatus: "verified"` and asserts the settled record is `cancelled` / `ok:false` / `not-applicable`.

### Batch: 32-job ceiling lifted to 256 behind a required active-concurrency bound

- `terrarium_spawn_batch` now accepts up to 256 jobs (was 32). The old 32-job cap only ever existed to bound simultaneous children, so it conflated the *queued* job count with the *active* child count.
- Batches over 32 jobs must pin an explicit `concurrency`. Because `launchBounded` holds each slot until its run is terminal, this keeps active children bounded at a fixed width while the queued job count scales up — massive parallel work flows through a small window instead of fanning out hundreds of simultaneous runs.
- A batch over 32 jobs *without* `concurrency` fails closed with a clear error rather than silently launching everything at once. Batches up to 32 keep their existing unbounded-by-default behavior, so nothing in the common path changes.
- `createRunGroup` ceiling raised in step (32 → 256) so a bounded large batch can register all of its run IDs in one durable group; groups remain correlation handles, not execution fan-out. New `MAX_BATCH_JOBS`, `DEFAULT_UNBOUNDED_JOBS`, and `MAX_GROUP_RUNS` constants make the contract testable. MCP schema `maxItems`, ARCHITECTURE/CONCURRENCY_ISOLATION/COMPATIBILITY docs, and `test/batch.test.js` updated.

### Doctor: self-heal executor drives the mechanically-safe repair subset

- `terra doctor` already emitted a `repairPlan` of runnable steps, but an operator still had to dispatch each step by hand. New `executeRepairPlan` (in `src/doctor.js`) drives the mechanically-safe, idempotent subset — `recover` missing terminal callbacks, `requeue` stale inflight callbacks, `prune` stale child-slot claims — by reusing the *exact* primitives the plan points at (`ensureTerminalCallback`, `requeueInflightEvents`, `pruneStaleChildClaims`). An applied repair is identical to running each plan step manually.
- `terra doctor --repair` reports the plan as a dry run by default (no mutation); `terra doctor --repair --apply` opts in to execution. Output pairs the diagnosis with a `{ ok, dryRun, appliedCount, skippedCount, applied, skipped }` repair receipt.
- Judgement-heavy steps (`orphanedRun`/`needsAttentionRun` inspection) and out-of-band steps (`malformedRouterRecords` quarantine) are never auto-executed — they are reported as `skipped` with a reason so the operator stays in the loop. A per-step failure is captured as a skip rather than aborting the whole plan.
- Stale child-claim steps are collapsed into a single global prune pass (`pruneStaleChildClaims` reclaims every stale slot in one go), so the executor runs prune at most once per invocation. Repair execution is a top-level controller affordance and rejects child callers, mirroring `terra doctor` and `terrarium_callbacks { action: "prune" }`. `terrarium_doctor` over MCP stays read-only. Added `test/doctor-repair.test.js`; README and COMPATIBILITY note the new `--repair`/`--apply` flags.

### CLI: mistyped subcommands fail closed instead of spawning a child for the typo

- `terra statsu`, `terra docter`, and other near-miss commands now print a suggestion (`Did you mean "terra status"?`) and exit `2` instead of silently spawning a child agent whose task is the typo itself.
- Reserved verb commands fail closed when their subcommand is missing or unrecognized: `terra group` lists `create, status, read`; `terra schedule run f.json` is corrected toward `replay`; `terra group stats <id>` suggests `group status`. Previously these fell through the dispatch chain and burned a real run on the broken command.
- Genuine free-form tasks are never reclassified as command typos: the guard only fires on short, lowercase, flagless, command-shaped first tokens within a length-scaled edit distance of a known command. Capitalized, multi-word, or option-shaped inputs always run as tasks.
- Added `--task` (force the argument to run as a task) and `TERRARIUM_NO_COMMAND_GUARD=1` escape hatches for the rare case where a real task looks like a command typo.
- New `src/command-guard.js` holds the pure, unit-tested recognition logic (Levenshtein distance, command/subcommand tables) so the dispatch contract is testable independently of the CLI process. README documents the behavior and escape hatches.

### Receipts: verified contract survives trailing stdout floods

- The synchronous (foreground) run path now validates the `TERRARIUM_RESULT` task receipt against the full captured stdout, not the bounded ~12 KB display tail. A child could legitimately emit a valid receipt and then print more than a tail window of trailing output (verbose summaries, diffs, logs), which pushed the receipt line out of the tail and misreported a genuinely verified run as `missing` / `inconclusive`. This made the receipt — Terrarium's single source of operational truth — fragile to reconstruct under noisy children.
- The background supervisor path already validated against full stdout; this closes the asymmetry so both paths reach the same verdict for the same output.
- The persisted `stdoutTail` is still bounded for display, and the full contract output is never written to durable metadata. Added a regression test that emits a receipt followed by 50 KB of trailing stdout and asserts the run finalizes `done` / `verified`.

### Repair: stale child-slot claims are now mechanically prunable

- `terrarium_callbacks { action: "prune" }` now also reclaims stale child-slot claims, not just router/journal records. A child-slot claim that points at a missing/invalid run log (the child was pruned, or its supervisor died during the launch handoff before writing a log) permanently consumed one of the parent's bounded child-budget slots with no mechanical remedy.
- `terra doctor`'s `repairPlan` `staleChildClaim` step now carries a runnable `tool`/`args` (`terrarium_callbacks { action: "prune" }`) and is counted in `repairPlanSummary.actionable`, instead of being a detection-only signal a reconstructing agent could not dispatch.
- Pruning uses doctor's exact staleness criteria, never removes a slot held by a live run log, is restricted to a top-level controller (rejects child callers), and garbage-collects any `.children` directory it empties. Added `test/prune-child-claims.test.js`.

### Batch: winner-picking strategies resolve by true finish order

- `race`, `any`, and `quorum` now select winners by each run's durable `finishedAt` timestamp instead of job-array position. At large batch scale a single status snapshot routinely reports several freshly-terminal runs at once; the previous code returned the run the caller happened to list first, making "first terminal / first success wins" a lie.
- A terminal run whose snapshot is momentarily missing `finishedAt` sorts last, so it can never out-race a run with a known, earlier finish time. Exact-timestamp ties break deterministically by `runId`.
- `decide()` is now exported as a pure function and covered by deterministic unit tests (finish-order selection, tie-breaking, and the missing-timestamp guard) that need no spawned children.

### Go core migration: first runnable kernel slice

- Added an experimental Go module with `cmd/terra-core`, a pure single-run state machine, JSON command protocol, and a prototype one-process runner under `go/runner`.
- Added a thin TypeScript adapter gated by `TERRARIUM_GO_CORE`; default behavior remains JavaScript, and `terra --version --json` can report when the Go core served the call.
- Added `terra plan` as an inert, read-only child-invocation planner. It can be served by Go via `TERRARIUM_GO_CORE` or fall back to JavaScript; it does not spawn a child or mutate run state.
- Fixed the adapter wire protocol to drive the Go binary in `--stdin` JSON-envelope mode, preventing silent payload corruption where `status` / `dry-run` could otherwise return placeholder fields with exit 0.
- Added a Go-vs-TypeScript decision rubric and real-run evidence tests. Current evidence says TypeScript remains better for production execution today while Go continues behind the stable adapter boundary.
- Documented the intended split: Go core owns receipts/process supervision/batch/sweeps over time; TypeScript keeps CLI/Node/MCP/Pi adapters and Cloudflare Worker Pulse.
- This is not a deploy and not a runtime cutover. The stable public primitive and existing JavaScript execution path remain authoritative until comparative real-run evidence says otherwise.

### Docs: Pulse durable edge wake transport

- Added [docs/PULSE.md](./docs/PULSE.md): problem, one-sentence promise, curl quick start (emit/claim/ack/status with the bearer token), a compact emitter → worker → PulseRouter DO + SQLite → claim/ack diagram, a proof-to-test table tying each guarantee to its test file, explicit limits/non-goals, and a where-to-edit map.
- README now carries a focused Pulse section and links to the full doc; the capability table and doc list reference Pulse.
- Limits are stated plainly: owner isolation is enforced at claim/ack/status (not at delivery/match, a conscious host-trust choice), production e2e against the live Access URL is pending, and existing consumers are not yet rewired to read from the cloud router.

### Docs: one authoritative success proof, not four

- README now has an "Authoritative success proof" section that names the single proof chain (child exit 0 + verified `TERRARIUM_RESULT` receipt → `done`/`ok:true`) and explicitly states that callbacks, groups, the public ledger, and the changelog are not that proof.
- The MCP `terrarium_callbacks` and `terrarium_group` descriptions now carry the not-proof disclaimer inline.
- README now includes an at-a-glance proof table that separates authoritative, evidence, diagnostic, notification, and presentation surfaces.
- Renamed the README "Proof of the original primitive" adoption section to "Adoption signal for the original primitive" so adoption metrics are not confused with per-run success proof.

### Receipts: exit 0 is still not success

- `TERRARIUM_RESULT=` is now an exact four-field object: `runId`, `taskFingerprint`, `nonce`, and `summary`.
- The receipt marker line is capped at 16 KiB. Extra fields, prototype-shaped keys, duplicate markers, oversized payloads, and invalid-then-valid receipt attempts fail closed as malformed.
- Receipt parsing still accepts CR, U+2028, and U+2029 line boundaries, but only for a column-zero marker.
- Product-loop public summaries are also exact-schema records: unknown fields, malformed IDs/kinds, non-boolean evidence claims, multiline/padded prose, and evidence references on non-claims are rejected.

### Callbacks: malformed events do not enter the queue

- Added an experimental Cloudflare Pulse callback backend with Durable Object storage and capability-token-gated HTTP routes for route/subscribe/claim/ack/status, sharing validation and matching semantics with the filesystem router.
- Pulse now has direct Durable Object unit coverage for dedup, replay, owner isolation, requeue, malformed events, wildcard Pi delivery guards, and tampered subscriber records, in addition to Miniflare HTTP e2e and production asset-topology coverage that proves `/pulse`, `/claim`, `/ack`, and `/status` reach the worker instead of the SPA fallback.
- Callback-heavy tests now scrub inherited Terrarium child lineage/budget environment where they spawn their own children, and one doctor shared-state assertion now tolerates unrelated concurrent journal mutations.
- Callback events now require canonical UTC millisecond timestamps before journal persistence.
- Concrete replay validates legacy journal records before mailbox enqueue. Malformed historical records stay retained for diagnosis, but are not delivered as callbacks.
- MCP callback descriptions now say delivery is at-least-once with dedup: acknowledged events are not redelivered, but requeue can replay an inflight event that was claimed and never acknowledged.
- Missing callback subscribers are normalized to the same concise denial as inaccessible subscribers.
- Router and doctor validation now agree on canonical timestamps, subscriber IDs, event IDs, and state-specific pending/inflight/acked callback shapes.

### Batch: winner-picking joins resolve by finish time, not job order

- `race`, `any`, and `quorum` now pick winners by who actually finished first (earliest per-run `finishedAt`), not by the order jobs were listed. At large batch scale many runs go terminal within one poll interval, so a single status snapshot routinely contains several freshly-terminal runs; the old code resolved to whichever job the caller happened to list first, quietly contradicting the documented "first terminal / first success wins" contract.
- Exact `finishedAt` ties break deterministically by `runId`, so winner selection is reproducible across snapshots.
- A run that is terminal in a snapshot but whose `finishedAt` is momentarily unreadable sorts last, never first, so a run with no known finish time can never out-race a run that provably finished earlier.
- Added deterministic unit coverage of the pure `decide` join function for finish-time ordering, tie-breaking, and the missing-`finishedAt` edge case, exercised without racing real subprocesses.

### Batch: durable IDs survive cleanup races

- Batch `timeoutMs` / CLI `--batch-timeout-ms` now bounds the active-concurrency launch stage too, returning durable IDs for launched children and `phase: "launch"` instead of waiting for every queued job to launch before timing out.
- Bounded-concurrency launch no longer has a hidden 30s terminal-wait cap that could turn long but healthy child runs into false launch failures while their durable run records kept progressing.
- `cleanupTimeoutMs` bounds synchronous loser-cancellation settlement for batch calls. The default remains 5 seconds.
- Batch results preserve durable `groupId`, `runIds`, launch counts, launch errors, and `cleanupErrors` so callers can inspect follow-up state instead of losing correlation to a client timeout.
- `terra batch --batch-timeout-ms` now exposes the whole-batch wait budget separately from per-child `--timeout-ms`; `terra batch --cleanup-timeout-ms` continues to forward the cancellation-settlement budget available through the Node/MCP batch API.
- Repository MCP schema exposes `cleanupTimeoutMs`; stale live MCP hosts may need a tool-metadata refresh before the field appears in a running client.
- MCP `initialize` now reports runtime `apiVersion`, `schemaVersion`, `batchApiVersion`, and `batchSupportedOptions`, and the MCP schema version was bumped with that runtime-handshake contract so clients can compare fresh runtime truth against cached tool metadata before relying on stale schemas.
- Batch responses now include `apiVersion`, `schemaVersion`, and `supportedOptions` so callers can distinguish repo/API support from stale host tool metadata. `apiVersion` is the batch contract version (`terrarium-batch-*`); `schemaVersion` is the MCP wire/tool-metadata version (`terrarium-mcp-*`) so it can be compared directly against the `schemaVersion` in cached tool metadata.
- Batch API version now reflects the bounded-launch contract that removed the hidden 30s launch-stage terminal wait.
- Every advertised MCP tool now carries `schemaVersion`, matching the initialize handshake, so stale cached tool metadata is detectable per tool. The MCP schema version was bumped with that tool-metadata contract.

### Cancellation and orphaning: terminal means one callback

- Dead-supervisor/no-child-PID cancellation handoff settles as `cancelled` and emits one terminal callback.
- Late receipts observed after cancellation are ignored and cannot replace the cancelled terminal result.
- Stale running records reconciled to `orphaned` now emit a terminal callback with `status: orphaned` and `ok: false`.

### Groups and lineage: no partial truth leaks

- Durable run groups remain scoped by run lineage for status/read/cancel.
- Group status/read/cancel fail closed when any member is inaccessible.
- Missing group IDs and inaccessible groups use indistinguishable concise errors.
- Group truthfulness is explicit: missing members are not complete, and `ok` requires every member to be `done` with `ok: true`.

### Doctor: local state is diagnostic, not trusted truth

- `terra doctor` / `terrarium_doctor` reports malformed subscribers, journals, pending/inflight/acked callbacks, stale inflight callbacks, stale child claims, missing terminal callbacks, and current API/schema versions.
- Terminal run envelopes and concise group member rows now link to the durable callback journal entry via `terminalCallback.eventId` / delivery facts, keeping callbacks as notifications while making run-to-router reconstruction direct.
- Doctor output now includes bounded ID-level details for active, orphaned, attention-needed, missing-callback, and stale child-claim records so operators can reconstruct local state from concrete handles instead of counts alone.
- Malformed subscriber/callback timestamps, subscriber IDs, event IDs, and child-claim contents are reported instead of being treated as valid state.
- Malformed acknowledged callbacks are included in router repair candidate diagnostics where appropriate, while malformed retained history is not silently pruned.

### Workspace and secure workspace boundaries

- Copy/worktree marker files no longer include source checkout paths.
- Root and nested `.terrarium-workspace` files are excluded from captured patch receipts.
- Secure workspace archive transfer no longer uses shell interpolation.
- Secure workspace tools reject direct and nested credential paths and omit them from listing/search.
- Secure-agent Pi receives only a small non-provider environment allowlist. Provider credentials are not inherited into secure mode.
- Docker-backed secure workspace verification still requires a Docker-capable host; local non-Docker regressions pass.
- Secure-v1 docs now enumerate the concrete Docker resource limits and clarify that provider env vars are dropped for the host Pi process while `HOME` credentials may remain reachable by that trusted transport, not by the container.

### Public ledger and documentation discipline

- The public site now exposes a changelog page linked from the run ledger.
- `CHANGELOG.md` is the source of truth; `app/public/CHANGELOG.md` mirrors it exactly.
- README now states the documentation-hardening rule: update README and changelog when behavior, public surfaces, safety semantics, or CLI/MCP outputs change.
- The public run ledger redacts runner command and model identity as `not published` while preserving the spreadsheet columns.
- Public evidence references reject traversal-shaped `test:` refs and URL-like `replay:` refs.

### Known limitations

- The active parent MCP/tool host may cache an older `terrarium_spawn_batch` schema until it refreshes tool metadata; repo CLI/Node/MCP code already supports `cleanupTimeoutMs`.
- Docker-backed secure workspace tests are skipped on hosts without Docker.
- `copy` and `worktree` isolation are workspace separation modes, not security sandboxes.
- Terrarium callbacks are notifications, not authoritative proof of task success; callers still need run IDs, task fingerprints, nonces, receipts, and tests.

## 2026-06-26

### Public surface

- Replaced the public demo story view with a dense spreadsheet-style run ledger.
- Added public-safe product-loop receipts and evidence links for hardening runs.
- Redacted public model identity in the run ledger by using `not published` in the Agent/model column.
- Added product-loop dry-run, plan checks, and validation tests.

### Batch and groups

- Added and iterated `terrarium_spawn_batch` / `terra batch` for explicit flat fan-out over independent runs.
- Changed batch settlement so `allSettled` does not disguise child failures as success.
- Added batch cleanup diagnostics including `cleanupErrors`, launch error fields, launch counts, and concise MCP projection.
- Stopped queued batch launches after the first launch-worker failure.
- Added durable run groups and scoped group status/read/cancel access by lineage.
- Made group status/read/cancel fail closed when any member is inaccessible.
- Made missing group IDs indistinguishable from inaccessible groups through concise MCP errors.
- Fixed group truthfulness: missing members are not complete, and `ok` requires every member to be `done` with `ok: true`.

### Callbacks

- Hardened callback subscriber ownership: subscribers cannot be hijacked, adopted, or pruned across owner boundaries.
- Bound Pi callback delivery to concrete spawned run IDs instead of wildcard channel delivery.
- Stopped auto-loading the Pi host extension. Callback consumption is manual by default; hosts may explicitly install `src/pi-extension.js` for concrete-run subscriptions and callback-triggered Pi follow-ups.
- Made terminal callbacks durable across finish-before-subscribe and restart races.
- Sanitized callback journals/mailboxes so task prompts, cwd, output, and log paths are not stored.
- Hardened callback mailbox validation by state: pending, inflight, and acknowledged records have distinct accepted shapes.
- Made callback claim/ack/requeue/status/prune reject malformed/private-field records while retaining them for diagnosis.
- Added MCP callback argument checks for missing `runId`, `subscriberId`, and `eventId`.

### Receipts, cancellation, doctor

- Hardened task receipt parsing: `TERRARIUM_RESULT=` must be a column-zero marker and CR/U+2028/U+2029 line boundaries are recognized.
- Added cancellation launch-handoff recovery so dead-supervisor/no-child-PID runs with durable cancel markers settle as `cancelled` and emit one terminal callback.
- Added runner failure classifications for Pi busy, opencode model configuration failures, and retryable runner failures.
- Added `terra doctor` / `terrarium_doctor` diagnostics for malformed subscribers, journals, pending/inflight/acked callbacks, stale inflight callbacks, stale child claims, and missing terminal callbacks.
- Refined doctor repair candidate counts so stale inflight callbacks are repairable, while malformed acknowledged history is retained for inspection.

## Earlier

- Established Terrarium as a small runner-independent execution/callback layer around one bounded delegated task at a time.
- Kept the stable CLI/Node/MCP primitive: `terra "task"`, `terrarium_spawn`, `terrarium_status`, and `terrarium_read`.
- Added workspace separation modes: `none`, `copy`, and `worktree`; documented that they are not security sandboxes.
- Added secure-v1/secure-agent experiments and documentation for capability-brokered workspaces.
- Added lifecycle replay fixtures for cancellation/completion ordering.
- Added public campaign/site infrastructure and later archived/replaced story-driven presentation with the run ledger.
