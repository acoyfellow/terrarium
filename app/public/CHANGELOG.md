# Changelog

Succinct, product-facing changes to Terrarium. This is not a full commit log; it records notable behavior, API, safety, and public-site changes.

## Unreleased

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

- Callback events now require canonical UTC millisecond timestamps before journal persistence.
- Concrete replay validates legacy journal records before mailbox enqueue. Malformed historical records stay retained for diagnosis, but are not delivered as callbacks.
- MCP callback descriptions now say delivery is at-least-once with dedup: acknowledged events are not redelivered, but requeue can replay an inflight event that was claimed and never acknowledged.
- Missing callback subscribers are normalized to the same concise denial as inaccessible subscribers.
- Router and doctor validation now agree on canonical timestamps, subscriber IDs, event IDs, and state-specific pending/inflight/acked callback shapes.

### Batch: durable IDs survive cleanup races

- Bounded-concurrency launch no longer has a hidden 30s terminal-wait cap that could turn long but healthy child runs into false launch failures while their durable run records kept progressing.
- `cleanupTimeoutMs` bounds synchronous loser-cancellation settlement for batch calls. The default remains 5 seconds.
- Batch results preserve durable `groupId`, `runIds`, launch counts, launch errors, and `cleanupErrors` so callers can inspect follow-up state instead of losing correlation to a client timeout.
- `terra batch --cleanup-timeout-ms` now forwards the same cleanup budget available through the Node/MCP batch API.
- Repository MCP schema exposes `cleanupTimeoutMs`; stale live MCP hosts may need a tool-metadata refresh before the field appears in a running client.
- Batch responses now include `apiVersion`, `schemaVersion`, and `supportedOptions` so callers can distinguish repo/API support from stale host tool metadata. `apiVersion` is the batch contract version (`terrarium-batch-*`); `schemaVersion` is the MCP wire/tool-metadata version (`terrarium-mcp-*`) so it can be compared directly against the `schemaVersion` in cached tool metadata.
- Every advertised MCP tool now carries `schemaVersion`, matching the initialize handshake, so stale cached tool metadata is detectable per tool.

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
