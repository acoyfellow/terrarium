# Changelog

Succinct, product-facing changes to Terrarium. This is not a full commit log; it records notable behavior, API, safety, and public-site changes.

## Unreleased

- Added a public changelog page to the site and linked it from the run ledger.
- Added `CHANGELOG.md` as the source of truth for concise release notes.
- Added a documentation-hardening expectation to the README: update README and changelog when behavior or public surfaces change.
- Clarified README/CHANGELOG wording for the opt-in Pi host extension: it is not auto-loaded, but hosts may install it explicitly.
- Redacted public runner command cells to `not published` while keeping the spreadsheet column.
- Normalized missing callback subscribers to the same concise denial as inaccessible subscribers.
- Bounded synchronous batch cancellation settlement with `cleanupTimeoutMs` (default 5 seconds), preserving durable IDs and `cleanupErrors` before MCP client request deadlines.
- Made product-loop public summaries an exact schema: unknown fields, malformed IDs/kinds, non-boolean evidence claims, multiline/padded prose, and evidence references on non-claims are rejected.
- Hardened doctor diagnostics: malformed subscriber/callback timestamps are reported, and malformed acknowledged callbacks are included in router repair candidates.
- Added `terra batch --cleanup-timeout-ms` and test coverage for the corresponding MCP schema field.
- Aligned router and doctor timestamp validation on canonical UTC timestamps and subscriber ID validation so malformed callback records fail closed consistently.
- Made task receipts an exact four-field contract and capped `TERRARIUM_RESULT=` marker lines at 16 KiB.
- Emitted terminal callbacks when stale running records reconcile to `orphaned`.
- Removed source paths from workspace isolation markers and excluded nested `.terrarium-workspace` files from captured patches.
- Hardened secure workspace boundaries: shell-free archive transfer, credential path filtering, and a non-provider secure-agent environment allowlist.

## 2026-06-26

- Replaced the public demo story view with a dense spreadsheet-style run ledger.
- Added public-safe product-loop receipts and evidence links for hardening runs.
- Redacted public model identity in the run ledger by using `not published` in the Agent/model column.
- Hardened public evidence references: traversal-shaped `test:` refs and URL-like `replay:` refs are rejected.
- Hardened public receipt validation so evidence-backed summaries require typed, checkable evidence references.
- Added and iterated `terrarium_spawn_batch` / `terra batch` for explicit flat fan-out over independent runs.
- Changed batch settlement so `allSettled` does not disguise child failures as success.
- Added batch cleanup diagnostics including `cleanupErrors`, launch error fields, launch counts, and concise MCP projection.
- Stopped queued batch launches after the first launch-worker failure.
- Added durable run groups and scoped group status/read/cancel access by lineage.
- Made group status/read/cancel fail closed when any member is inaccessible.
- Made missing group IDs indistinguishable from inaccessible groups through concise MCP errors.
- Fixed group truthfulness: missing members are not complete, and `ok` requires every member to be `done` with `ok: true`.
- Hardened callback subscriber ownership: subscribers cannot be hijacked, adopted, or pruned across owner boundaries.
- Bound Pi callback delivery to concrete spawned run IDs instead of wildcard channel delivery.
- Stopped auto-loading the Pi host extension. Callback consumption is manual by default; hosts may explicitly install `src/pi-extension.js` for concrete-run subscriptions and callback-triggered Pi follow-ups.
- Made terminal callbacks durable across finish-before-subscribe and restart races.
- Sanitized callback journals/mailboxes so task prompts, cwd, output, and log paths are not stored.
- Hardened callback mailbox validation by state: pending, inflight, and acknowledged records have distinct accepted shapes.
- Made callback claim/ack/requeue/status/prune reject malformed/private-field records while retaining them for diagnosis.
- Added MCP callback argument checks for missing `runId`, `subscriberId`, and `eventId`.
- Added `terra doctor`/`terrarium_doctor` diagnostics for malformed subscribers, journals, pending/inflight/acked callbacks, stale inflight callbacks, stale child claims, and missing terminal callbacks.
- Refined doctor repair candidate counts so stale inflight callbacks are repairable, while malformed acknowledged history is retained but not counted as requeueable.
- Hardened task receipt parsing: `TERRARIUM_RESULT=` must be a column-zero marker and CR/U+2028/U+2029 line boundaries are recognized.
- Added cancellation launch-handoff recovery so dead-supervisor/no-child-PID runs with durable cancel markers settle as `cancelled` and emit one terminal callback.
- Added runner failure classifications for Pi busy, opencode model configuration failures, and retryable runner failures.
- Added product-loop dry-run, plan checks, and validation tests.

## Earlier

- Established Terrarium as a small runner-independent execution/callback layer around one bounded delegated task at a time.
- Kept the stable CLI/Node/MCP primitive: `terra "task"`, `terrarium_spawn`, `terrarium_status`, and `terrarium_read`.
- Added workspace separation modes: `none`, `copy`, and `worktree`; documented that they are not security sandboxes.
- Added secure-v1/secure-agent experiments and documentation for capability-brokered workspaces.
- Added lifecycle replay fixtures for cancellation/completion ordering.
- Added public campaign/site infrastructure and later archived/replaced story-driven presentation with the run ledger.
