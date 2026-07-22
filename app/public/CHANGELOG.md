# Changelog

Dated, factual record of what shipped or got fixed. Newest first. Not a full commit log.

## 2026-07-21

- Added `terrarium_report_failure`: turns a caught terminal failure into a deduped bug report under `~/.terrarium/failure-reports` (`src/failure-report.js`, 10 tests).
- Fixed cloud receipt `mismatch:runId`: the runner assembles the canonical receipt from the contract; the child model echoes only the nonce.
- Fixed cloud terminal callbacks: routed events carry `ownerId`, so background spawns wake the session again.
- Fixed `terrarium_spawn_batch` opaque `{ok:false}`: batch refusals now report `phase`/`code`/`error`.
- Fixed local spawn routing: `TERRARIUM_ALLOW_LOCAL=1` now routes a filesystem-dependent spawn to the local backend instead of refusing it to cloud.

## 2026-07-20

- Added `POST /api/batches` fan-out: N bounded tasks as one batch, failure-truth aggregate, child run IDs only, `maxConcurrency` capped at 8 per owner (14 tests + 7/7 receipt).
- Added owner-authenticated web consoles `/runs` and `/batches`.
- Changed console auth to GitHub sign-in (HttpOnly session cookie); the bearer path is unchanged (16 tests).
- Deployed to production.

## 2026-07-19

- Added `GET /api/runs`: owner-scoped, indexed run list filterable by `channel`, `status`, `since`.
- `terrarium_status` list-mode now reads the cloud run index for cloud runs.
- `doctor` flags when the configured `cloudUrl` disagrees with the live process environment.
- Repo-grounded cloud tasks delegate to Cloudbox; filesystem-dependent cloud tasks fail closed; cancel of a terminal cloud run is idempotent (issue #18).

## 2026-07-18

- Cloud is now the default backend: `terrarium_spawn` and `terrarium_spawn_batch` run on Cloudflare against your deployed instance. Local is opt-in (`TERRARIUM_ALLOW_LOCAL=1`).
- Deployed cloud-parity work to production; verified the full callback chain on prod.
- Rotated control and pulse tokens on qual and prod.

## 2026-07-17

- Added cloud support to `terrarium_status`, `terrarium_read`, and `terrarium_cancel`.
- Added cloud fan-out to `terrarium_spawn_batch` (`all`/`allSettled`/`race`/`any`/`quorum`), cancelling losing cloud runs.
- Cloud terminal callbacks now push into the Pi session over HTTP.
- `terrarium_spawn` executes on the Cloudflare cell by default (`src/cloud-client.js`); a real spawn with no cloud configured fails closed.
- Fixed a callback-death class: a run that died before launch now emits its terminal callback.
- Added a durable accept-receipt before launch, so a timed-out spawn RPC never loses the run ID.
- Bounded `terrarium_status` list-mode scans (`TERRARIUM_LIST_SCAN_WINDOW`) with `channel`/`workflowId`/`sinceMs` recovery filters.
- Made the startup watchdog liveness-aware: a log-growing child is no longer false-killed (`TERRARIUM_STARTUP_HARD_CEILING_MS`).
- `doctor` reports workspace leaks (`workspaceDirs`/`workspaceBytes`/`leakedWorkspaces`).

## 2026-07-06

- Added a manual, reversible deploy workflow (`.github/workflows/deploy.yml`) with a full-suite gate and health checks.
- Added cold-start backpressure: a bounded server-only startup grace (default 90s, `TERRARIUM_STARTUP_GRACE_MS`) so cold-boot time does not consume the run budget.
- Cloud execution cell live in production: `POST /api/runs` runs a bounded task in a Cloudflare-managed Pi cell (`Dockerfile.pi`) with a verified receipt, durable logs, and a terminal callback.
- Model access is a credentialless server-owned Workers AI route; no reusable credential enters the cell.
- Verified in prod: idempotency, cancel/deadline precedence, auth fail-closed, cross-principal isolation, oversized-task gate (413), R2 log overflow with SHA-256 integrity, restart/reattach, exactly-once callback.

## 2026-06-29

- Removed the Go-core adapter path; TypeScript is the only production engine (`docs/ENGINE_DECISION.md`).
- Standardized page widths and mobile behavior across home, docs, runs, and changelog.
- Fixed active-run truth: a stale supervisor-only record reconciles to `orphaned` instead of keeping the run active.

## 2026-06-27 — Hardening loop

- Command typo guard: a mistyped subcommand fails closed with a suggestion instead of spawning an agent for the typo (`src/command-guard.js`).
- Receipt validation reads full stdout, so a valid receipt followed by trailing output is not misclassified as missing.
- Cancelled or deadlined runs no longer keep a `verified` task-contract status; it collapses to `not-applicable` (JS and Go run-machine).
- Batch ceiling raised from 32 to 256 jobs; over 32 requires an explicit `concurrency`. `validateBatchShape` returns a structured preflight verdict with a suggested concurrency.
- Winner-picking joins (`race`/`any`/`quorum`) resolve by durable `finishedAt`, ties broken by `runId`.
- `terra doctor --repair` dry-runs safe repairs; `--apply` runs the recover/requeue/prune subset; `--verify` re-diagnoses and reports residual evidence.
- Callback dead-letter cap: `deliveryAttempts` tracked; poison callbacks quarantine into a `dead` mailbox.
- Precise inflight requeue: `requeueInflightEvents` accepts an `eventIds` allowlist.
- Pi extension no longer wedges on a missing subscriber at session start or on one poison callback.
- `terrarium_callbacks { action: "prune" }` also reclaims stale child-slot claims.
- Go run-machine reaches replay conformance with the JS core (`replay` command, shard-P test).

## 2026-06-26

- Replaced the demo story view with a dense run-ledger table; model identity redacted as `not published`.
- Added `terrarium_spawn_batch` / `terra batch` flat fan-out; `allSettled` no longer disguises child failures as success.
- Added durable run groups with lineage-scoped status/read/cancel; group `ok` requires every member `done, ok: true`.
- Hardened callback subscriber ownership; callbacks are durable across finish-before-subscribe and restart races; journals store no task prompts, cwd, output, or log paths.
- `TERRARIUM_RESULT=` must be a column-zero marker; receipt parsing recognizes CR/U+2028/U+2029 boundaries.
- Added cancellation launch-handoff recovery: a dead-supervisor run with a cancel marker settles `cancelled` with one callback.
- Added `terra doctor` / `terrarium_doctor` diagnostics for malformed subscribers, journals, callbacks, stale claims, and missing terminal callbacks.

## Earlier

- Established Terrarium as a runner-independent execution and callback layer around one bounded delegated task.
- Shipped the stable primitive: `terra "task"`, `terrarium_spawn`, `terrarium_status`, `terrarium_read`.
- Added workspace separation modes (`none`, `copy`, `worktree`); documented that they are not security sandboxes.
- Added the secure-v1 / secure-agent capability-brokered workspace experiments.
- Added lifecycle replay fixtures for cancellation and completion ordering.
