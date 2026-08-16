# Changelog

Dated, factual record of what shipped or got fixed. Newest first. Not a full commit log.

## 2026-08-15

- Fixed `taskProof` on the background run-machine path. A child receipt still classified as `verified` and skipped the host proof, so a failing `grade.mjs` left six skill-eval arms `verified`. The host proof now runs after receipt classification. A failing proof marks the run `inconclusive` with `taskContractStatus: "unproven"`.

## 2026-08-14

- Fixed Terrarium children that stayed `running` with no model output after a parent cmux session-start hook failed. Child env now disables Pi cmux hooks and strips inherited `CMUX_*` targeting so a child cannot call the parent's pane.

## 2026-08-11

- Added a limited Effect 4 migration. The bundled `terrarium-effect@1.0.0` package, on `effect@4.0.0-beta.107`, handles cloud foreground spawn, background admission, and cloud batch orchestration. Local execution and cloud status, read, and single-run cancel remain on the existing JavaScript paths. The root `effect@^3.21.3` dependency remains. This records a limited implementation scope, not a full migration or production proof.

## 2026-08-07

- Added `taskProof` to `terrarium_spawn`. A task receipt only ever proved that the child echoed back the run ID, fingerprint, and nonce it was given, plus any non-empty summary. Every field is self-reported, so a child that invented its whole output and echoed the nonce was recorded as `verified`, and `terrarium_report_failure` then refused to file a report because the run looked like a trusted success. In one session three of twelve children fabricated their output and all three passed. `taskProof` is a shell command that Terrarium runs itself, in the run's cwd, after the child exits. The child never executes it and cannot forge its exit code. A non-zero exit downgrades the run to `inconclusive` with `taskContractStatus: "unproven"`. Proof output is captured, bounded, and time-limited. Runs without a proof are unchanged.
- Added a concurrent-writer warning to `terrarium_spawn`. A session ran 65 children in one shared cwd with `isolation: "none"` and 67 pairs overlapped in time; two writers editing the same files made mtime and hash forensics blame the wrong run. A spawn that joins a live unisolated writer in the same cwd now returns `concurrentWriterWarning` naming the colliding runs. Advisory only: isolated and read-only spawns are never warned, and detection failure never blocks a spawn.
- Fixed a child that died about one second after launch with `Unknown provider`. The configured provider is supplied by a Pi extension, so an agent command containing `-ne` (`--no-extensions`) disabled extension discovery and removed that provider from Pi's configuration. Terrarium now rejects that combination at preflight, before it claims a child slot.

## 2026-07-28

- Fixed a cloud spawn that could time out without returning a run ID. The durable accept-receipt existed only on the local path while cloud was the default backend, so an MCP transport timeout left no record under `~/.terrarium/runs`: no status, no logs, no cancel, no callback recovery, and no deduped failure report. A cloud run is now persisted at admission, before polling, and batch jobs inherit it.
- Seeded the model ladder with four cost-tiered rungs on the pinned provider (`gemini-2.5-flash-lite`, `claude-haiku-4-5`, `gpt-5.6-terra`, `claude-sonnet-4-5`), so a ladder has real models to climb. Override the catalog with `spawnModelCatalog` in `~/.terrarium/config.json`.
- Fixed a child that finished its work but emitted no receipt. A long task pushed the `TERRARIUM_RESULT=` contract far from where the model stops generating, so the run was reported as receipt-absent even though the commits landed. The child prompt now closes with the receipt requirement.
- Fixed the last flaky test in the suite. The local-batch routing test launched a real agent and hit a 15-second kill; it now pins an immediately-exiting agent. The full suite is deterministic at 778 tests.
- Added a model fallback ladder to `terrarium_spawn`. A foreground `modelStrategy` (`low-to-high`, `high-to-low`, or `custom` with an ordered model array) advances to the next model when a task returns a retryable contract failure (a missing, malformed, or mismatched receipt with exit code zero), instead of retrying the same flaky model. It composes with `maxRetries` and stops at once on a non-zero exit. The response records `ladderPath` and `attemptRunIds`. Background and nested runs reject it.

## 2026-07-26

- Reviewed public docs and website copy against ASD-STE100 Simplified Technical English. Removed decorative em-dash drama, "not X - it's Y" reframes, rule-of-three cadence, metaphor-as-evidence, and Unicode arrows. Kept definitional em-dashes.

## 2026-07-25

- Restored the proof-chain documentation: the README names one authoritative success proof, not four confusable surfaces. Callbacks and group roll-ups are notifications, not proof; adoption numbers are a signal, not proof. Each run still proves itself with its own receipt.

## 2026-07-22

- Rewrote the README and CHANGELOG in Simplified Technical English; validated every claim against the code.
- Fixed local spawn routing: `TERRARIUM_ALLOW_LOCAL=1` routes a filesystem-dependent spawn to the local backend instead of refusing it to cloud.
- Fixed the service worker: per-build cache ID plus network-first for mutable content, so a deploy is never masked by a stale cache.

## 2026-07-21

- Added `terrarium_report_failure`: turns a caught terminal failure into a deduped bug report under `~/.terrarium/failure-reports` (`src/failure-report.js`, 10 tests).
- Fixed cloud receipt `mismatch:runId`: the runner assembles the canonical receipt from the contract; the child model echoes only the nonce.
- Fixed cloud terminal callbacks: routed events carry `ownerId`, so background spawns wake the session again.
- Fixed `terrarium_spawn_batch` opaque `{ok:false}`: batch refusals now report `phase`/`code`/`error`.

## 2026-07-20

- Added `POST /api/batches` bounded fan-out: N tasks as one batch, `admitOneRun` reuse, failure-truth aggregate, `maxConcurrency` capped at 8 per owner (5 proof gates + 7/7 receipt).
- Added the owner-authenticated `/runs` console: channel groups, status/since filters, 401-handled.
- Added the `/batches` console: submit a bounded batch, poll the failure-truth aggregate.
- Changed console auth to a GitHub OAuth session; the bearer path is unchanged.
- Fixed cloud config resolution: fall back to `~/.terrarium/config.json` when the env is absent.
- Deployed to production.

## 2026-07-19

- Added `GET /api/runs`: owner-scoped, indexed run list, filterable by `channel`, `status`, `since`.
- Added a per-principal run-index projection (KV), wired into `RunControlDO` admit/terminal hooks.
- Routed `terrarium_status` list-mode to the cloud run index for cloud runs.
- Added a `doctor` stale-MCP-process-env check (config `cloudUrl` versus live process env).
- Fixed idempotent cancel of an already-terminal cloud run (issue #18).
- Fixed hallucinated review receipts: filesystem-dependent cloud tasks now fail closed.

## 2026-07-18

- Cloud is now the default backend: `terrarium_spawn` and `terrarium_spawn_batch` run on Cloudflare against your deployed instance.
- Routed `terrarium_status`, `terrarium_read`, and `terrarium_cancel` to cloud for cloud runs.
- Added cloud-native `terrarium_spawn_batch` fan-out.
- Cloud terminal callbacks now push into the Pi session.
- Fixed `/health` to report the real execution mode, not the campaign-lab fixture flag.
- Deployed cloud-parity work to production; verified the full callback chain on prod.

## 2026-07-17

- Made `terrarium_spawn` execute on the Cloudflare cell by default; local is opt-in and fails closed otherwise.
- Gated `terrarium_spawn_batch` under cloud-default, so there is no half-wired local batch.
- Fixed a callback-death class: an accepted-but-never-launched run now emits a terminal callback.
- Added `doctor` workspace-footprint reporting and leaked-workspace flags.

## 2026-07-15

- Added a durable accept-receipt before slow spawn launch, so a timed-out spawn RPC never loses the run ID.
- Added `listRuns` `channel`/`workflowId`/`sinceMs` recovery filters for post-timeout run-ID recovery.
- Bounded `listRuns` and status-list scans to a recent-file window.
- Made the startup watchdog liveness-aware, so a slow-cold-start child is not false-killed.
- Pinned `TERRARIUM_HOME` for the detached supervisor process.

## 2026-07-08

- Shipped the cloud Pi execution cell and documented the `/api/runs` production service.
- Added a reversible deploy CI workflow and a cold-start deadline grace.
- Made model selection server-config-owned and allowlisted.
- Added a live production benchmarks section to the website.

## 2026-06-29

- Removed the Go-core adapter path; TypeScript is the only production engine (`docs/ENGINE_DECISION.md`).
- Fixed active-run truth: a stale supervisor-only record reconciles to `orphaned` instead of staying active.
- Standardized page widths and mobile behavior across home, docs, runs, and changelog.

## 2026-06-26 to 06-27 — Hardening loop

- Command typo guard: a mistyped subcommand fails closed with a suggestion instead of spawning an agent for the typo (`src/command-guard.js`).
- Full-stdout receipt validation, so a valid receipt followed by trailing output is not misclassified as missing.
- Cancelled or deadlined runs no longer keep a `verified` contract status; it collapses to `not-applicable` (JS and Go run-machine, cross-language replay conformance).
- Batch ceiling raised from 32 to 256 jobs; over 32 requires explicit `concurrency`; `validateBatchShape` returns a structured preflight verdict with a suggested value.
- Winner-picking joins (`race`/`any`/`quorum`) resolve by durable `finishedAt`, ties broken by `runId`.
- `terra doctor --repair` dry-runs safe repairs; `--apply` runs the recover/requeue/prune subset; `--verify` re-diagnoses and reports residual evidence.
- Callback dead-letter cap with `deliveryAttempts`; poison callbacks quarantine into a `dead` mailbox; precise `eventIds` requeue.
- Group tools scoped by run lineage; group reads fail closed on any inaccessible or malformed member.
- Callback mailbox ownership enforced; subscriber takeover prevented; payloads and timestamps validated.
- Runner failure classification surfaced in MCP output (Pi-busy retryable, opencode model-config).
- Replaced the demo story view with a condensed run-ledger table; public model identity redacted.

## 2026-06-25

- Froze the public lab and focused Terrarium on durable callbacks.
- Kept Pi callbacks bound to the spawning session.

## 2026-06-23

- Added `terrarium_spawn_batch`: one-call fan-out with join strategies (`all`/`allSettled`/`race`/`any`/`quorum`).
- Made terminal callbacks durable across finish-before-subscribe races and restarts.
- Made run timing decisions replayable.

## 2026-06-21

- Added durable run groups with process-tree cancellation and lineage-scoped status/read/cancel.
- Added scoped exactly-once callback delivery, requeue, and retention pruning.
- Detached MCP agent runs by default; callbacks stay opt-in for compatibility.
- Added top-level `doctor` operational diagnostics.
- Added ephemeral Pi defaults, a factual attention status, and run groups in the native Pi widget.

## 2026-06-18

- Added an Effect-based event runtime with a scoped router and explicit channels.
- Added a periodic progress heartbeat and an active-run count across concurrent runs.
- Fixed parallel child context isolation and task correlation.

## 2026-06-16

- Added the secure-v1 execution profile and a permanent hardening gate; recorded a five-task benchmark.
- Wrapped Pi in a run-scoped code-mode secure workspace.
- Added a two-round epoch runner and a trusted public event stream.
- Healed three verified findings (encoded leaks, sibling fanout, dependency downgrade) with safe traces and a GitHub proof chain.

## 2026-06-15

- Added a bounded campaign memory and a batch strategist with healing-loop attack scenarios.
- Added control-plane attack scenarios to the campaign registry.
- Serialized real campaigns with a Durable Object lock.
- Fixed a stale shell: network-first HTML in the service worker (v2).

## 2026-06-14

- Added an SEO + PWA baseline: metadata, OG/Twitter, JSON-LD, manifest, service worker, and icons.

## 2026-06-13

- Unified boundaries into one campaign scenario registry with a local multi-surface runner.

## 2026-06-12

- Switched the public campaign to a receipt-backed live ledger; attacker model metadata stays private.
- Hardened control-plane boundaries; enforced budgets on manual real campaigns.
- Added a trusted policy gate that wires verified findings into isolated fixer branches.
- Expanded the hostile corpus with runtime boundary probes.

## 2026-06-11

- Added configurable child models and the Pi runner.
- Added authenticated bounded manual hostile campaigns and a generated campaign gallery demo.

## 2026-06-04 to 06-05

- Added the opt-in containment lab: baseline, reporting fixtures, and probes that run without host bind mounts.
- Added a reusable fixture policy, an issue-publication workflow, and a synthetic fixture-remediation PR loop.
- Added a guarded real-mode payload envelope and a policy endpoint with a pause-aware real guard.

## 2026-05-14 to 05-20

- Rewrote the README around reader flow; added a real terrarium hero image.
- Exposed MRE side-log paths for child runs.
- Hardened background runs and log reads; improved child ergonomics.
- Kept the MCP stdio alive through a bin symlink.

## 2026-05-01

- Added workspace isolation modes (`none`, `copy`, `worktree`); documented that they are not security sandboxes.
- Added the Wake continuity eval and the agent operating-loop eval.
- Reconcile stale Terrarium runs.

## 2026-04-30

- Created Terrarium: a runner-independent execution and callback layer around one bounded delegated task.
- Shipped the stable primitive (`terra "task"`, `terrarium_spawn`, `terrarium_status`, `terrarium_read`), the MCP interface, run metadata, and depth guards.
