# Changelog

This file records notable behavior, API, safety, and public-site changes to Terrarium. It is not a full commit log.

## 2026-07-21 — Caught failures become filed bug reports (`terrarium_report_failure`)

- **New `terrarium_report_failure` MCP tool and `src/failure-report.js` core.** Terrarium already catches failures. A child whose process exits without a trusted, contract-matching receipt is marked failed. This tool turns one caught failure into a **structured, deduped bug report**. It fetches the run's terminal status and log by run ID, for cloud or local runs. It classifies the failure as one of `receipt-mismatch`, `receipt-absent`, `receipt-malformed`, `agent-timeout`, `model-config`, `ca-trust`, or `poll-timeout`. It adds a blame hint of `agent`, `backend`, or `image`. It redacts and head/tail-excerpts the log. It files the report under `~/.terrarium/failure-reports`. Pass `markdown:true` for a ready-to-paste bug-report body.
- **Defect-level dedupe.** The dedupe signature keys on the failure class, sub-reason, exit code, and blame. It does not key on the run ID or timestamp. So N runs that fail the same way collapse into one report with an `occurrences` count and a `seenRunIds` list. Terrarium refuses a trusted success or a still-running run (`not-a-failure`).
- **A caught failure becomes a filed record.** A caught failure is no longer only a line in a status poll. It becomes a filed, triageable record. The tool is scoped to top-level controllers, like `terrarium_doctor`. A nested child cannot file a global report. Covered by `test/failure-report.test.js` (10 tests: classification of the real `mismatch:runId`, timeout, and malformed cases; trusted-success refusal; log redaction; dedupe-collapse versus distinct-defect separation; markdown render).
- The tool surfaces one weakness it caught. It does not fix it. The fixed cloud child model does not reliably echo the assigned `runId` into its receipt line. So real work fails the contract as `mismatch:runId`. The report names the failure and blames `agent`. The model and runner fix is tracked separately.

## 2026-07-20 — Web consoles sign in with GitHub (no token-paste)

- **The `/runs` and `/batches` consoles now authenticate with a GitHub sign-in.** They no longer take a pasted control token. `/auth/login` runs the GitHub OAuth web flow. It sets an HttpOnly, HMAC-signed session cookie. The browser sends that cookie automatically. The page never holds a token. Only the one configured GitHub login may sign in (`GITHUB_ALLOWED_LOGIN`, the instance owner). A session lasts 12 hours. The programmatic Bearer path (`Authorization: Bearer …`) is unchanged for the CLI, the MCP, and other services. The API now accepts either a valid bearer or a valid session cookie. Both resolve to the same owner principal.
- The consoles fail closed. Without OAuth config (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `GITHUB_ALLOWED_LOGIN`), `/auth/*` refuses. The consoles show "sign in" but cannot complete a login. The API still requires a bearer. So nothing opens up by default. Covered by `test/cloud-web-session.test.js` (16 tests: signed-cookie round-trip, tamper and expiry rejection, wrong-login rejection, bearer-or-cookie owner auth, OAuth state check, no open redirect, and HttpOnly/Secure/SameSite cookie flags).

## 2026-07-20 — Batch fan-out API + web console for runs and batches

- **New `POST /api/batches` fan-out surface.** One call admits N bounded tasks as a single batch. Each task composes through the same `admitOneRun()` path as `POST /api/runs`. There is no forked admission logic. A `maxConcurrency` window bounds the batch, capped at the per-owner ceiling of 8. The route returns `202 { batchId, admitted, requested, maxConcurrency, peakLive, childRunIds, rejected }`. `GET /api/batches/:id` returns an aggregate that **references child run IDs only**. It never inlines a child receipt. It derives status with **failure-truth**. A batch reads `done` only when every child is terminal and ok. Any failed, cancelled, or inconclusive child forces `failed`. Any running child keeps it `running`. A non-success is never rolled up as a success. Proof gates are covered by `test/cloud-api-batches.test.js` and a re-runnable receipt (`scripts/c2-batch-happy-path.mjs`, 7/7).
- **New owner-authenticated web console pages.** `/runs` lists your runs grouped by channel, filterable by status and since. `/batches` submits a bounded batch and polls the failure-truth aggregate: running, done, and failed counts, plus child run rows. Both pages handle `401` cleanly instead of showing a broken page. The first version used a pasted control token. GitHub sign-in superseded it the same day. See the entry above.
- **Deployed to production** (`terrarium.coey.dev`) with a serial-join sequence: clean-HEAD build, single version upload, verify, capture the rollback ref, promote, and live-verify. Live-verified on one version: health `200`; the `/runs` and `/batches` pages `200`; `GET /api/runs`, `POST /api/batches`, and `GET /api/batches/:id` all `401` when unauthenticated (route-wired, structured JSON); an unknown route `404`. The rollback target was captured.

## 2026-07-19 — Owner-scoped run index (`GET /api/runs` list)

- **New `GET /api/runs` list endpoint.** It lists your runs, owner-scoped and indexed. Filter by `channel`, `status`, and `since`. It returns `{ runs, channels }`. A per-principal run-index projection backs it (`src/cloud/run-index.js`, KV), written from `RunControlDO` admit and terminal hooks. So listing is a cheap index read, not a full store scan.
- **`terrarium_status` list-mode now reads the cloud run index** for cloud runs. So status listing reflects real cloud state, not only local records.
- **`doctor` gained a stale-MCP-process-env check.** It flags when the configured `cloudUrl` disagrees with the live process environment. This catches a class of misconfiguration where the MCP points at the wrong instance.
- **Cloud task steering hardened.** Repo-grounded tasks delegate to Cloudbox. A filesystem-dependent cloud task fails closed instead of emitting a hallucinated review receipt. Cancel of an already-terminal cloud run is idempotent (issue #18).

## 2026-07-18 — Cloud is the default: spawns run on Cloudflare, end to end

- **Milestone: Terrarium now runs on Cloudflare by default.** `terrarium_spawn` and `terrarium_spawn_batch` execute in a Cloudflare-managed cell against your deployed instance. Verified receipts, status, logs, cancel, and terminal callbacks all work against cloud runs. No process runs on your machine. Local execution is an explicit opt-in (`TERRARIUM_ALLOW_LOCAL=1`) for cooperative digs only. A real spawn with no cloud configured fails closed instead of silently running local. The README and site now describe cloud-first, matching the code.
- **Deployed the cloud-parity work to production** (`terrarium.coey.dev`). Prod had been running 2026-07-11 code. The callback-reliability fix and the cloud status, read, cancel, batch, and callback work are now live. The rollback target was captured. Post-deploy, health returned 200 and unauthenticated `/api/runs` returned 401.
- **Verified the full cloud callback chain on prod.** A background spawn reached a Pulse mailbox. A claim then returned `Completed`. Then ack. The chain took about 10 seconds. Cloud terminal callbacks wake a session on prod exactly as on qual.
- Rotated control and pulse tokens on both qual and prod (a solo-project reset). Operator token files are saved locally for the MCP and extension.

## 2026-07-17 — Cloud parity: status/read/cancel + cloud batch fan-out

- **`terrarium_status`, `terrarium_read`, and `terrarium_cancel` work on cloud runs.** A server-minted cloud run ID is inspected or cancelled against the cloud instance. Any status-by-id while cloud is the default also routes to the cloud. Local runs stay local. Verified live: cloud status returned `done` and `verified`; read returned the real `TERRARIUM_RESULT` log.
- **`terrarium_spawn_batch` fans out on the cloud cell.** The cloud-native batch submits independent cloud runs. It resolves them through the same pure join logic as the local batch (`all`, `allSettled`, `race`, `any`, `quorum`). It cancels losing cloud runs. Verified live: `all` left both runs done; `any` let the first success win and cancelled the running loser.
- **Cloud terminal callbacks now push into the Pi session.** The extension registers a cloud Pulse subscriber. It pulls and acks terminal callbacks over HTTP (`TERRARIUM_URL` plus a pulse token). This is the cloud analogue of the local FS router. Verified live end to end: subscribe, then a background cloud spawn, then a claim of `Completed`, then ack. A background cloud run wakes the session exactly as a local run did.

## 2026-07-17 — Cloud-default execution (terrarium_spawn runs on Cloudflare)

- **`terrarium_spawn` now executes on the Cloudflare-managed cell by default.** Set `TERRARIUM_URL` plus `TERRARIUM_CONTROL_TOKEN` (or `TERRARIUM_TOKEN_FILE`). A spawn then submits `POST /api/runs`, runs in the cloud, and returns a verified correlated receipt. No local process runs. The cell holds no host authority. New file: `src/cloud-client.js`.
- **Local execution is opt-in and fails closed otherwise.** With no cloud configured and no `TERRARIUM_ALLOW_LOCAL=1`, a real spawn errors with an actionable message. It does not silently spawn a local child. That local spawn was the accidental default. The cloud service shipped live on 07-06. But the MCP had no client for it. So operator sessions ran locally. `dryRun` always plans locally and is exempt.
- **`terrarium_spawn_batch` fails closed under cloud mode.** Cloud group, status, and cancel fan-out is not built yet. So the tool directs you to individual cloud `terrarium_spawn` calls, or to `TERRARIUM_ALLOW_LOCAL=1` for a local batch. It never runs a silent, half-wired local batch.
- Verified end to end against the live cell: cloud spawns return `done`, `verified`, and `verified-receipt` with server-minted nonces.

## 2026-07-17 — Callback reliability + spawn-timeout hardening + doctor observability

- **Fixed a callback-death class.** A spawn could die between the durable accept-receipt and launch, so no supervisor or child ever started. It settled to `orphaned` but never emitted its terminal callback. A caller waiting on that callback hung forever. The reconcile path now persists the terminal state and emits the terminal callback. The emit is idempotent. So a never-launched run always wakes its waiting caller. Regression-tested.
- **Durable accept-receipt before launch.** `POST` and spawn now persist a `status:"accepted"` record before slow launch work like workspace copy and git. The record holds the run ID, log path, channel, workflow ID, and fingerprint. So a spawn RPC that times out during a slow handshake never loses the run ID. The run stays discoverable through `terrarium_status` and `listRuns`. A stale `accepted` run that never launched reconciles to a terminal `orphaned` with a callback.
- **Status stays fast and recoverable under a large store.** `terrarium_status` list-mode bounds its scan to a recent-file window (`TERRARIUM_LIST_SCAN_WINDOW`). It no longer reads the whole run store. It accepts `channel`, `workflowId`, and `sinceMs` recovery filters. So a caller that lost a run ID to a timeout re-associates the run instead of relaunching a duplicate.
- **Liveness-aware startup watchdog.** A live, log-growing child is no longer false-killed for being slow to first stdout under concurrent cold starts. It dies only at an absolute hard ceiling (`TERRARIUM_STARTUP_HARD_CEILING_MS`). The base window only fast-fails a dead-and-silent child. Per-spawn and per-job `startupWatchdogMs` is exposed over MCP.
- **`doctor` workspace observability.** It reports `workspaceDirs`, `workspaceBytes`, and `leakedWorkspaces`. It warns when an isolation workspace survived a terminal run without `keepWorkspace`. This makes the earlier monorepo-copy leak class visible instead of silent.
- **Detached supervisor home isolation.** The background supervisor process is pinned to the parent's `TERRARIUM_HOME`. So tests and scoped homes never leak runs into the default store. The test runner also self-isolates a temp home.

## 2026-07-06 — Deploy CI + cold-start backpressure

- Added a manual, reversible deploy workflow (`.github/workflows/deploy.yml`). A human dispatches it and chooses qualification or production. It runs the full suite as a gate. It captures the pre-deploy version as a rollback target. It deploys. It health-checks `/health` (200) and unauthenticated `/api/runs` (401, fail-closed). Then it reports rollback instructions. Nothing deploys on push.
- Added cold-start backpressure. The run deadline now includes a bounded, server-only startup grace. The default is 90 seconds, set by `TERRARIUM_STARTUP_GRACE_MS`, and clamped. So container cold-boot and queue time no longer consume the caller's execution budget. Before this, a burst of simultaneous cold boots deadline-killed healthy runs before their process started. The grace bounds execution, not queueing. It is never client-controlled.

## 2026-07-06 — Cloud execution cell live in production

- The cloud execution service is live on `terrarium.coey.dev`. Authenticated `POST /api/runs` admits one bounded task. It runs the task in a Cloudflare-managed Pi execution cell. It returns a durable run with a verified correlated receipt, durable logs, and a principal-scoped terminal callback. No local machine takes part.
- The execution runtime is Pi (`@earendil-works/pi-coding-agent`, pinned). It is built on the plain `cloudflare/sandbox` amd64 base (`Dockerfile.pi`). The cell reaches the model only through a credentialless, server-owned Workers AI route intercepted by `ContainerProxy`. No reusable model credential enters the cell. OpenCode is no longer the cloud runtime path.
- Receipt authority holds under adversarial test. A prompt-injection task that emits a forged `TERRARIUM_RESULT` cannot change the server-minted correlation of `runId`, `taskFingerprint`, and `nonce`. It can influence only the advisory `summary`. The server always mints the nonce. A client-supplied `spec.nonce` is ignored.
- Verified in production:
  - real task execution with computed answers;
  - idempotency (same key returns the same run ID);
  - cancel and deadline precedence (fail-closed, no receipt);
  - auth fail-closed (401 and 400);
  - cross-principal isolation (401);
  - the oversized-task admission gate (413);
  - R2 log overflow retrieval with byte-count and SHA-256 integrity (the receipt-in-overflow bug is fixed);
  - restart and reattach across a mid-run redeploy;
  - exactly-once terminal callback claim and ack.
- Known limit: broad simultaneous cold container boots beyond warm capacity can be deadline-killed (fail-closed, no fake receipt). This is operational and capacity work, not a correctness defect.

## 2026-06-29 — Website layout polish

- Standardized homepage, docs, runs, and changelog page widths around one readable container instead of mixing full-bleed and narrow layouts.
- Tightened mobile behavior for docs and run ledger pages: one docs navigator per breakpoint, horizontally safe code blocks/tables, and card-style run rows on small screens.

## 2026-06-29 — Engine decision: TypeScript only

- Removed the user-facing Go-core adapter path. Terrarium no longer presents `TERRARIUM_GO_CORE` as an alternate runtime flag for `terra plan` or `terra --version`.
- Added `docs/ENGINE_DECISION.md`: TypeScript is the production engine; Go remains internal conformance/research code unless it replaces the normal path with full proof.
- Updated operator docs so planning is simply `terra plan`, not a Go-backed experimental path.

## 2026-06-29 — Active-run truth fix

- `terra status` / `terrarium_status` no longer keeps stale runs active when the child process is gone but a detached supervisor process remains alive. Stale supervisor-only records reconcile to `orphaned`, so old leaks cannot keep the active count or Pi spinner alive.
- The Pi Terrarium extension now rechecks durable run records and live PIDs before it keeps its spinner active. It also clears stale active IDs on a timer, even when a callback or tool-result edge was missed.

## 2026-06-27 — Hardening loop shipped

### 20 shipped wins

- **Win 1 — command typo guard:** `terra statsu` and other mistyped reserved subcommands now fail closed with a suggestion. They no longer silently spawn an agent for the typo.
- **Win 2 — full-stdout receipt validation:** a foreground run validates `TERRARIUM_RESULT` against the full captured stdout. So a valid receipt followed by lots of output is no longer misclassified as missing.
- **Win 3 — orphan truth normalization:** orphaned runs cannot preserve stale `pending` or unfinalized `verified` task-contract claims.
- **Win 4 — runnable doctor repair plans:** doctor records concrete repair handles for stale inflight callbacks and stale child-slot claims.
- **Win 5 — deterministic batch winners:** `race`, `any`, and `quorum` choose winners by durable `finishedAt`, not job-array order.
- **Win 6 — browser-ready Pulse CORS:** Pulse supports pre-auth browser preflight and CORS-readable responses while keeping bearer-token auth as the security boundary.
- **Win 7 — large bounded batches:** `terrarium_spawn_batch` and durable groups accept up to 256 queued jobs, with explicit `concurrency` required above 32.
- **Win 8 — doctor self-heal dry-run/apply:** `terra doctor --repair` dry-runs safe repairs and `--apply` executes only the recover/requeue/prune subset.
- **Win 9 — poison callback visibility:** filesystem and Pulse requeue track `deliveryAttempts` and report `maxAttempts` for claimed-but-unacked events.
- **Win 10 — cancelled/deadlined receipt truth:** receipts observed before cancellation or deadline no longer survive as `verified` on terminated runs.
- **Win 11 — batch preflight verdicts:** `validateBatchShape` exposes structured batch errors before launching any child.
- **Win 12 — large-batch concurrency hints:** over-32-job batch preflight returns an actionable suggested concurrency value.
- **Win 13 — doctor repair residual evidence:** `terra doctor --repair --apply --verify` re-diagnoses after repair and reports before/after counters.
- **Win 14 — Go terminated-run truth parity:** the Go run-machine now matches the JS cancelled/deadlined `not-applicable` contract normalization.
- **Win 15 — honest human status tables:** `terra status` separates liveness status from task-contract truth; `--json` preserves raw machine output.
- **Win 16 — group contract-truth rollups:** run groups report `contractTruth` buckets so process `ok` cannot hide cancelled or inconclusive members.
- **Win 17 — Go/TS replay conformance:** the inert Go core supports `replay`, and JS tests drive identical input sequences through both cores.
- **Win 18 — callback dead-letter cap:** filesystem and Pulse claim paths can cap `deliveryAttempts` and quarantine poison callbacks into a `dead` mailbox.
- **Win 19 — precise inflight requeue:** `requeueInflightEvents` accepts an `eventIds` allowlist so one failed follow-up can be retried without disturbing siblings.
- **Win 20 — Pi bounded poison replay:** the Pi host passes a delivery-attempt cap so permanently failing callbacks are quarantined instead of waking forever.

### Go/TS parity: a cross-language replay conformance net that drives identical input sequences through both run-machine cores

- **The gap.** The Go run machine (`internal/run`) is a faithful port of `src/run-machine.js`. But the only cross-language check (shard A) compared the two cores at the initial-state level: machine version, initial phase, initial receipt. It could not observe how each core classifies a terminated run. That is the exact surface where the cancelled/deadlined lie lived. That lie: "a verified receipt observed before the kill survives as `taskContractStatus: verified`." It was reproduced in the Go port and fixed only after the JS fix. No mechanism fed the same ordered input sequence to both cores to assert they finalize identically.
- **The fix.** The inert Go core gains a fourth command, `replay` (`internal/protocol`), driven over `terra-core --stdin`. It drives an ordered sequence of already-observed inputs through `run.Transition`. Those inputs are `ChildExited`, `ReceiptObserved`, `CancelRequested`, `DeadlineReached`, `ProcessTerminated`, and `RuntimeError` — the same shapes `transition()` accepts. It returns the final state plus the per-step decision list. It stays inert: no clocks, processes, files, or state mutation, matching `dry-run`, `status`, and `version`. A bad input returns a clean per-index failure response (`inputs[0]: ...`). It does not crash.
- **The conformance net.** New `test/go-vs-ts-replay-conformance-shard-p.test.js` feeds a battery of sequences to both cores: the TS `transition()` core and the Go core's `replay`. The sequences cover every receipt classification (`verified`, `missing`, `mismatch`, `malformed`, `not-required`), the receipt-before-exit and receipt-before-cancel/deadline races, verified-but-nonzero-exit, late-input idempotence, and a runtime error. The test asserts byte-for-byte parity on the consumer-facing terminal fields: `status`, `ok`, `exitCode`, `taskContractStatus`, `taskResultSummary`, and `reason`. It pins the cancelled/deadlined invariant directly: a `not-applicable` terminal must leak no `taskResultSummary` in either core. The Go comparison skips cleanly when no `go` toolchain is present, or you use the test-built binary. The TS-only sequence assertions always run, so the suite stays CI-portable.
- New Go tests in `internal/protocol/protocol_test.go` cover the `replay` happy paths, the cancel-after-verified-receipt `not-applicable` collapse, the missing-receipt inconclusive path, bad-input rejection, and an empty-input replay that stays `running`. `COMPATIBILITY.md` records the two-implementation lockstep invariant and `docs/GO_CORE_MIGRATION.md` documents the `replay` entry point. `go test ./...` and the JS shard-A/shard-P suites are green with the Go comparison active. No deploy.

### Pi extension: a missing-subscriber session start and one poison callback can no longer wedge follow-up delivery

- **The session-start crash.** On every `session_start`, the Pi host extension ran `requeueInflightEvents` before any durable subscriber existed. For a brand-new session that had never spawned a run, `getSubscriber` threw `ENOENT`. The throw propagated out of the `session_start` handler. So the refresh `setInterval` was never armed. This left the runs widget and every callback-triggered follow-up dead for the whole session. The same `ENOENT` also surfaced through `claimMailboxEvents` inside `refresh`.
- **The poison-event strand.** `refresh` claimed a batch of terminal callbacks and delivered them in a loop: `pi.sendMessage(...)` then `acknowledgeMailboxEvent(...)`. A single throwing `sendMessage` aborted the whole loop. The cause was a transient Pi delivery failure or a poison event. So every later-claimed sibling callback in that batch stayed `inflight` and was never delivered. And `requeueInflightEvents` only ran at `session_start`. So those siblings stayed stuck inflight for the rest of the session. The 1.5s refresh never retried them.
- **The fix.** Router mailbox-draining ops (`claimMailboxEvents`, `requeueInflightEvents`) now resolve the subscriber through a new `resolveOptionalSubscriber` helper. It treats a never-registered subscriber as an empty mailbox, a graceful no-op, instead of an `ENOENT`. It preserves the owner access-control check verbatim for subscribers that do exist. In the Pi extension, each callback delivery is now isolated. A throwing `sendMessage` requeues only that event's ID back to pending, through the new `eventIds` allowlist on `requeueInflightEvents` with `olderThanMs: 0`. So the next refresh retries it. The surviving siblings in the same batch are still delivered. The receipt and ack contract is unchanged: an event is acked only after Pi accepts it.
- The new `eventIds` allowlist parameter on `requeueInflightEvents` requeues a precise inflight subset. It does not disturb siblings the consumer still holds in memory. Two test files were added. `test/pi-extension.test.js` covers fresh-session no-crash, single throwing send requeue and redelivery, and one poison event not stranding its sibling. `test/router.test.js` covers the `eventIds` filter requeuing only the named event and leaving siblings inflight. No deploy.

### Doctor: self-heal repair receipts can prove they reconciled (residual evidence)

- **The gap.** `executeRepairPlan` reported *what it ran* (`applied`/`skipped` counts) but never *whether the diagnosed condition actually cleared*. An operator reading a repair receipt with `ok: true` had a claim that recover/requeue/prune executed — not evidence that the stale callbacks, missing terminal events, or dead child-claims were gone. A callback that re-staled, or a slot a concurrent run re-took, would still read as a clean repair.
- **The fix.** On an applied, non-dry run, `executeRepairPlan({ verify: true })` re-runs `diagnoseTerrarium` after the repair. It attaches a `residual` evidence block. For each self-healing kind in the plan, it records `{ kind, counter, before, after, cleared }`. That maps the kind to its diagnosis counter (`missingTerminalCallbacks`, `staleInflightCallbacks`, or `staleChildClaims`). `before` comes from the pre-repair baseline. `after` comes from the re-diagnosis. `residual.verified` is true only when every checked counter reached zero. So a repair that ran but did not reconcile is now visible instead of masquerading as success.
- **Scope.** Verification only checks the mechanically-safe kinds the repair actually drove; judgement and quarantine steps are never auto-run, so they are never claimed as cleared. A dry run never verifies, because nothing changed to re-measure. This keeps the default path free of an extra diagnosis pass. It is exposed on the CLI as `terra doctor --repair --apply --verify`. `terrarium_doctor` over MCP stays read-only. Tests were added in `test/doctor-repair.test.js`. The README and COMPATIBILITY docs were updated.

### Batch: large-batch preflight gives an actionable suggested concurrency instead of a bare rejection

- Lifting the batch ceiling to 256 made the "over 32 jobs requires an explicit `concurrency` bound" rule the most common large-batch stumble. But the failure was only a thrown string buried inside `spawnBatch`. So a caller had to launch, or read the source, to discover both that a bound was required and what value to use.
- New pure, side-effect-free `validateBatchShape` (exported from `src/batch.js`) returns a structured verdict — `{ ok, code, error, jobCount, requiresConcurrency, suggestedConcurrency, effectiveConcurrency }` — so the batch contract is inspectable *before* any child launches. A large batch missing its bound now carries `code: "missing-concurrency"` and a concrete `suggestedConcurrency` (default `SUGGESTED_LARGE_BATCH_CONCURRENCY = 8`, capped at the job count), and the error string itself ends with `try concurrency: 8`.
- `spawnBatch` now validates *through* `validateBatchShape` and throws `verdict.error`, so the inspectable verdict and the thrown message are single-sourced and can never drift. All existing validation messages (job-count, strategy, quorum, concurrency, cleanupTimeoutMs) are preserved verbatim.
- The `terrarium_spawn_batch` MCP handler preflights the shape. It returns the structured verdict as a clean failure response at `phase: "preflight"`, with `code` and `suggestedConcurrency`. It no longer surfaces only a deep thrown string. The MCP `concurrency` schema description now notes the preflight rejection. No runs are launched on a rejected preflight.
- New `validateBatchShape` unit test in `test/batch.test.js` asserts the suggestion, the per-error codes, the `effectiveConcurrency` echo, and the single-source guarantee (`verdict.error` is exactly what `spawnBatch` throws). `CONCURRENCY_ISOLATION` and `COMPATIBILITY` docs updated. No deploy.

### Operational truth: the Go run-machine port had the same terminated-run-is-verified lie the JS fix already closed

- **The lie.** The JS "Win 10" fix established that a run terminated by cancellation or deadline produces no trusted completion. It collapses `taskContractStatus` to `not-applicable`. That changelog asserted the Go side was sound, because the Go runner (`go/runner`) has no `taskContractStatus` field. That was true, but it overlooked the Go run-machine port (`internal/run/machine.go`). That port faithfully ports `src/run-machine.js` and does carry `TaskContractStatus` and `TaskResultSummary`. Its `cancel-requested` and `deadline-reached` finalizers used a `contractOrNA()` helper. The helper normalized to `not-applicable` only when the receipt was still `pending`. So if a verified `ReceiptObserved` landed before the terminating intent, or before the child exit committed the terminal record, the cancelled/deadlined record settled with `status: cancelled` or `failed`, `ok: false`, but `taskContractStatus: "verified"`. That is the exact lie, reproduced in Go. The leaked summary path was identical.
- **The fix.** The Go `cancel-requested` and `deadline-reached` finalizers now hard-code `TaskContractStatus: "not-applicable"`. They never emit a `TaskResultSummary`. This holds independent of receipt arrival order. It matches the JS run-machine fix and the orphan terminal convention. The cancel-versus-completion status boundary is unchanged. A clean `ChildExited -> ReceiptObserved -> CancelRequested` still finalizes terminal before the cancel arrives and ignores the cancel as late input.
- Regression tests were added in `internal/run/machine_test.go`. The `cancel -> receipt -> exit`, `receipt -> cancel -> exit`, and `receipt -> deadline -> exit` orderings all assert `not-applicable` and an empty `taskResultSummary`. The existing `TestCancelWinsOverVerifiedReceipt` and `TestDeadlineWins` cases were strengthened to pin the contract field they previously left unchecked. That gap is why the bug shipped. Full `go test ./...` is green. No deploy.

### Wow hardening loop: wins 7–10

- **Win 7 — large bounded batches:** `terrarium_spawn_batch` and durable groups now accept up to 256 queued jobs, while requiring explicit `concurrency` above 32 so active children stay bounded.
- **Win 8 — doctor self-heal dry-run/apply:** `terra doctor --repair` now builds an executable repair summary and `--apply` can run the mechanically safe recover/requeue/prune subset; judgement-heavy steps remain skipped for an operator.
- **Win 9 — poison callback visibility:** filesystem and Pulse requeue now track `deliveryAttempts` and report `maxAttempts`, making repeatedly claimed-but-unacked callback events visible instead of silently looping forever.
- **Win 10 — cancelled/deadlined receipt truth:** receipts observed before cancellation or deadline no longer survive as `verified` task-contract status on cancelled/deadlined terminal records.

### Operational truth: a terminated run can no longer be reconstructed as a verified task success

- **The lie.** A child could emit a valid `TERRARIUM_RESULT` receipt, classifying `taskContractStatus: "verified"`, while still running. Then it could be cancelled or hit its deadline before the process exited. The run-machine and the dead-supervisor cancel-recovery paths preserved a non-`pending` receipt verbatim. So the terminal record settled as `status: "cancelled"` or `status: "failed"` with `ok: false`, but retained `taskContractStatus: "verified"`. Several consumers reconstruct operational truth from that field: durable group roll-ups (`getRunGroupStatus`), the Pi extension surface, and the MCP retry classifier. Each would read a terminated run as a successful task receipt.
- **The fix.** A run terminated by cancellation or deadline now counts as no trusted completion. The run-machine's `cancel-requested` and `deadline-reached` finalizers collapse the contract status to `not-applicable`, regardless of receipt arrival order. This matches the existing orphan terminal convention. The two `core.js` dead-supervisor recovery sites also normalize both `pending` and `verified` to `not-applicable`: the `reconcileRun` early-cancel branch and the `cancelRun` settle branch. The cancel-versus-completion status boundary is unchanged. A clean `ChildExited -> ReceiptObserved -> CancelRequested` still finalizes `done`, because cancellation arrives after terminal commit and is ignored as late.
- **The Go runner is sound for this class.** The experimental Go runner's `Result` models only process `status` (done, cancelled, timeout, error). It has no `taskContractStatus` field. So a terminated Go run cannot carry a stale verified receipt. The receipt-survives-termination bug is purely in the JS run-machine and core, and is fully scoped there.
- Regression tests were added in `test/run-machine.test.js`. The pure-machine `receipt -> cancel -> exit` and `receipt -> deadline -> exit` orderings assert `not-applicable` and no `taskResultSummary`. A core-layer dead-supervisor recovery test seeds `taskContractStatus: "verified"` and asserts the settled record is `cancelled`, `ok:false`, and `not-applicable`.

### Batch: 32-job ceiling lifted to 256 behind a required active-concurrency bound

- `terrarium_spawn_batch` now accepts up to 256 jobs (was 32). The old 32-job cap only ever existed to bound simultaneous children, so it conflated the *queued* job count with the *active* child count.
- A batch over 32 jobs must pin an explicit `concurrency`. `launchBounded` holds each slot until its run is terminal. So active children stay bounded at a fixed width while the queued job count scales up. Large parallel work flows through a small window instead of fanning out hundreds of simultaneous runs.
- A batch over 32 jobs without `concurrency` fails closed with a clear error. It does not silently launch everything at once. A batch up to 32 keeps its existing unbounded-by-default behavior. So nothing in the common path changes.
- The `createRunGroup` ceiling was raised in step (32 to 256). So a bounded large batch can register all of its run IDs in one durable group. A group remains a correlation handle, not execution fan-out. New constants `MAX_BATCH_JOBS`, `DEFAULT_UNBOUNDED_JOBS`, and `MAX_GROUP_RUNS` make the contract testable. The MCP schema `maxItems`, the ARCHITECTURE, CONCURRENCY_ISOLATION, and COMPATIBILITY docs, and `test/batch.test.js` were updated.

### Doctor: self-heal executor drives the mechanically-safe repair subset

- `terra doctor` already emitted a `repairPlan` of runnable steps, but an operator still had to dispatch each step by hand. New `executeRepairPlan` (in `src/doctor.js`) drives the mechanically-safe, idempotent subset: `recover` missing terminal callbacks, `requeue` stale inflight callbacks, and `prune` stale child-slot claims. It reuses the exact primitives the plan points at (`ensureTerminalCallback`, `requeueInflightEvents`, `pruneStaleChildClaims`). An applied repair is identical to running each plan step by hand.
- `terra doctor --repair` reports the plan as a dry run by default, with no mutation. `terra doctor --repair --apply` opts in to execution. The output pairs the diagnosis with a `{ ok, dryRun, appliedCount, skippedCount, applied, skipped }` repair receipt.
- Judgement-heavy steps (`orphanedRun` and `needsAttentionRun` inspection) and out-of-band steps (`malformedRouterRecords` quarantine) are never auto-executed. They are reported as `skipped` with a reason, so the operator keeps control. A per-step failure is captured as a skip. It does not abort the whole plan.
- Stale child-claim steps are collapsed into a single global prune pass. `pruneStaleChildClaims` reclaims every stale slot at once. So the executor runs prune at most once per invocation. Repair execution is a top-level controller affordance and rejects child callers, mirroring `terra doctor` and `terrarium_callbacks { action: "prune" }`. `terrarium_doctor` over MCP stays read-only. Added `test/doctor-repair.test.js`. The README and COMPATIBILITY note the new `--repair` and `--apply` flags.

### CLI: mistyped subcommands fail closed instead of spawning a child for the typo

- `terra statsu`, `terra docter`, and other near-miss commands now print a suggestion (`Did you mean "terra status"?`) and exit `2` instead of silently spawning a child agent whose task is the typo itself.
- Reserved verb commands fail closed when their subcommand is missing or unrecognized: `terra group` lists `create, status, read`; `terra schedule run f.json` is corrected toward `replay`; `terra group stats <id>` suggests `group status`. Previously these fell through the dispatch chain and burned a real run on the broken command.
- Genuine free-form tasks are never reclassified as command typos: the guard only fires on short, lowercase, flagless, command-shaped first tokens within a length-scaled edit distance of a known command. Capitalized, multi-word, or option-shaped inputs always run as tasks.
- Added `--task` (force the argument to run as a task) and `TERRARIUM_NO_COMMAND_GUARD=1` escape hatches for the rare case where a real task looks like a command typo.
- New `src/command-guard.js` holds the pure, unit-tested recognition logic (Levenshtein distance, command/subcommand tables) so the dispatch contract is testable independently of the CLI process. README documents the behavior and escape hatches.

### Receipts: verified contract survives trailing stdout floods

- The synchronous (foreground) run path now validates the `TERRARIUM_RESULT` task receipt against the full captured stdout. It no longer validates against the bounded ~12 KB display tail. A child could legitimately emit a valid receipt and then print more than a tail window of trailing output, such as verbose summaries, diffs, or logs. That output pushed the receipt line out of the tail. So a genuinely verified run was misreported as `missing` or `inconclusive`. This made the receipt fragile to reconstruct under a noisy child. The receipt is Terrarium's authoritative operational truth.
- The background supervisor path already validated against full stdout; this closes the asymmetry so both paths reach the same verdict for the same output.
- The persisted `stdoutTail` is still bounded for display, and the full contract output is never written to durable metadata. Added a regression test that emits a receipt followed by 50 KB of trailing stdout and asserts the run finalizes `done` / `verified`.

### Repair: stale child-slot claims are now mechanically prunable

- `terrarium_callbacks { action: "prune" }` now also reclaims stale child-slot claims. It no longer reclaims only router and journal records. A child-slot claim can point at a missing or invalid run log, because the child was pruned, or its supervisor died during the launch handoff before writing a log. Such a claim permanently consumed one of the parent's bounded child-budget slots, with no mechanical remedy.
- `terra doctor`'s `repairPlan` `staleChildClaim` step now carries a runnable `tool`/`args` (`terrarium_callbacks { action: "prune" }`) and is counted in `repairPlanSummary.actionable`, instead of being a detection-only signal a reconstructing agent could not dispatch.
- Pruning uses doctor's exact staleness criteria. It never removes a slot held by a live run log. It is restricted to a top-level controller and rejects child callers. It garbage-collects any `.children` directory it empties. Added `test/prune-child-claims.test.js`.

### Batch: winner-picking strategies resolve by true finish order

- `race`, `any`, and `quorum` now select winners by each run's durable `finishedAt` timestamp, not by job-array position. At large batch scale, a single status snapshot routinely reports several freshly-terminal runs at once. The previous code returned the run the caller happened to list first. That made "first terminal / first success wins" a lie.
- A terminal run whose snapshot is momentarily missing `finishedAt` sorts last. So it can never out-race a run with a known, earlier finish time. Exact-timestamp ties break deterministically by `runId`.
- `decide()` is now exported as a pure function. Deterministic unit tests cover it: finish-order selection, tie-breaking, and the missing-timestamp guard. They need no spawned children.

### Go core migration: first runnable kernel slice

- Added an experimental Go module with `cmd/terra-core`, a pure single-run state machine, JSON command protocol, and a prototype one-process runner under `go/runner`.
- Added a thin TypeScript adapter, gated by `TERRARIUM_GO_CORE` at the time. The 2026-06-29 engine decision later removed this path, so TypeScript is the only product engine.
- Added `terra plan` as an inert, read-only child-invocation planner. It is now served by TypeScript only; it does not spawn a child or mutate run state.
- Fixed the adapter wire protocol to drive the Go binary in `--stdin` JSON-envelope mode. This prevents a silent payload corruption where `status` and `dry-run` could otherwise return placeholder fields with exit 0.
- Added a Go-versus-TypeScript decision rubric and real-run evidence tests. Current evidence says TypeScript remains better for production execution today. Go continues behind the stable adapter boundary.
- Documented the intended split. The Go core owns receipts, process supervision, batch, and sweeps over time. TypeScript keeps the CLI, Node, MCP, and Pi adapters, and the Cloudflare Worker Pulse.
- This is not a deploy and not a runtime cutover. The stable public primitive and existing JavaScript execution path remain authoritative until comparative real-run evidence says otherwise.

### Docs: Pulse durable edge wake transport

- Added [docs/PULSE.md](./docs/PULSE.md). It has the problem and a one-sentence promise. It has a curl quick start for emit, claim, ack, and status with the bearer token. It has a compact `emitter -> worker -> PulseRouter DO + SQLite -> claim/ack` diagram. It has a proof-to-test table that ties each guarantee to its test file. It has explicit limits and non-goals, and a where-to-edit map.
- The README now carries a focused Pulse section and links to the full doc. The capability table and doc list reference Pulse.
- Limits are stated plainly. Owner isolation is enforced at claim, ack, and status. It is not enforced at delivery or match, a conscious host-trust choice. Production end-to-end testing against the live Access URL is pending. Existing consumers are not yet rewired to read from the cloud router.

### Docs: one authoritative success proof, not four

- The README now has an "Authoritative success proof" section. It names the single proof chain: child exit 0 plus a verified `TERRARIUM_RESULT` receipt, giving `done` and `ok:true`. It states plainly that callbacks, groups, the public ledger, and the changelog are not that proof.
- The MCP `terrarium_callbacks` and `terrarium_group` descriptions now carry the not-proof disclaimer inline.
- README now includes an at-a-glance proof table that separates authoritative, evidence, diagnostic, notification, and presentation surfaces.
- Renamed the README "Proof of the original primitive" adoption section to "Adoption signal for the original primitive" so adoption metrics are not confused with per-run success proof.

### Receipts: exit 0 is still not success

- `TERRARIUM_RESULT=` is now an exact four-field object: `runId`, `taskFingerprint`, `nonce`, and `summary`.
- The receipt marker line is capped at 16 KiB. Extra fields, prototype-shaped keys, duplicate markers, oversized payloads, and invalid-then-valid receipt attempts fail closed as malformed.
- Receipt parsing still accepts CR, U+2028, and U+2029 line boundaries, but only for a column-zero marker.
- Product-loop public summaries are also exact-schema records. They reject unknown fields, malformed IDs and kinds, non-boolean evidence claims, multiline or padded prose, and evidence references on non-claims.

### Callbacks: malformed events do not enter the queue

- Added an experimental Cloudflare Pulse callback backend. It has Durable Object storage and capability-token-gated HTTP routes for route, subscribe, claim, ack, and status. It shares validation and matching semantics with the filesystem router.
- Pulse now has direct Durable Object unit coverage: dedup, replay, owner isolation, requeue, malformed events, wildcard Pi delivery guards, and tampered subscriber records. It also has Miniflare HTTP end-to-end coverage and production asset-topology coverage. That coverage proves `/pulse`, `/claim`, `/ack`, and `/status` reach the worker instead of the SPA fallback.
- Callback-heavy tests now scrub inherited Terrarium child lineage and budget environment where they spawn their own children. One doctor shared-state assertion now tolerates unrelated concurrent journal mutations.
- Callback events now require canonical UTC millisecond timestamps before journal persistence.
- Concrete replay validates legacy journal records before mailbox enqueue. Malformed historical records stay retained for diagnosis, but are not delivered as callbacks.
- MCP callback descriptions now say delivery is at-least-once with dedup: acknowledged events are not redelivered, but requeue can replay an inflight event that was claimed and never acknowledged.
- Missing callback subscribers are normalized to the same concise denial as inaccessible subscribers.
- Router and doctor validation now agree on canonical timestamps, subscriber IDs, event IDs, and state-specific pending/inflight/acked callback shapes.

### Batch: winner-picking joins resolve by finish time, not job order

- `race`, `any`, and `quorum` now pick winners by who actually finished first, the earliest per-run `finishedAt`, not by the order jobs were listed. At large batch scale, many runs go terminal within one poll interval. So a single status snapshot routinely contains several freshly-terminal runs. The old code resolved to whichever job the caller happened to list first. That quietly contradicted the documented "first terminal / first success wins" contract.
- Exact `finishedAt` ties break deterministically by `runId`. So winner selection is reproducible across snapshots.
- A run that is terminal in a snapshot but whose `finishedAt` is momentarily unreadable sorts last, never first. So a run with no known finish time can never out-race a run that provably finished earlier.
- Added deterministic unit coverage of the pure `decide` join function: finish-time ordering, tie-breaking, and the missing-`finishedAt` edge case. It runs without racing real subprocesses.

### Batch: durable IDs survive cleanup races

- Batch `timeoutMs` and CLI `--batch-timeout-ms` now bound the active-concurrency launch stage too. On timeout they return durable IDs for launched children and `phase: "launch"`, instead of waiting for every queued job to launch.
- Bounded-concurrency launch no longer has a hidden 30-second terminal-wait cap. That cap could turn long but healthy child runs into false launch failures while their durable run records kept progressing.
- `cleanupTimeoutMs` bounds synchronous loser-cancellation settlement for batch calls. The default remains 5 seconds.
- Batch results preserve durable `groupId`, `runIds`, launch counts, launch errors, and `cleanupErrors` so callers can inspect follow-up state instead of losing correlation to a client timeout.
- `terra batch --batch-timeout-ms` now exposes the whole-batch wait budget, separate from per-child `--timeout-ms`. `terra batch --cleanup-timeout-ms` still forwards the cancellation-settlement budget available through the Node and MCP batch API.
- The repository MCP schema exposes `cleanupTimeoutMs`. A stale live MCP host may need a tool-metadata refresh before the field appears in a running client.
- MCP `initialize` now reports runtime `apiVersion`, `schemaVersion`, `batchApiVersion`, and `batchSupportedOptions`. The MCP schema version was bumped with that runtime-handshake contract. So a client can compare fresh runtime truth against cached tool metadata before it relies on a stale schema.
- Batch responses now include `apiVersion`, `schemaVersion`, and `supportedOptions`. So a caller can distinguish repo and API support from stale host tool metadata. `apiVersion` is the batch contract version (`terrarium-batch-*`). `schemaVersion` is the MCP wire and tool-metadata version (`terrarium-mcp-*`), so it compares directly against the `schemaVersion` in cached tool metadata.
- The batch API version now reflects the bounded-launch contract that removed the hidden 30-second launch-stage terminal wait.
- Every advertised MCP tool now carries `schemaVersion`, matching the initialize handshake. So stale cached tool metadata is detectable per tool. The MCP schema version was bumped with that tool-metadata contract.

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
- Terminal run envelopes and concise group member rows now link to the durable callback journal entry through `terminalCallback.eventId` and delivery facts. This keeps callbacks as notifications and makes run-to-router reconstruction direct.
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
- Secure-v1 docs now enumerate the concrete Docker resource limits. They clarify that provider env vars are dropped for the host Pi process. `HOME` credentials may remain reachable by that trusted transport, not by the container.

### Public ledger and documentation discipline

- The public site now exposes a changelog page linked from the run ledger.
- `CHANGELOG.md` is the authoritative copy. `app/public/CHANGELOG.md` mirrors it exactly.
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
