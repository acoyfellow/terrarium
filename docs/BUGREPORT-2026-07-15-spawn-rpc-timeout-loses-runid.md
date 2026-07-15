# BUGREPORT 2026-07-15 — spawn/batch RPC timeout loses the runId (fail-closed orchestration gap)

Status: **root-cause verified; immediate cause mitigated; status-availability hardening SHIPPED; durable-accept-receipt still open.**

## Progress

- ✅ **Immediate cause mitigated** — 24k-file/1.8GB home archived; test-home isolation guard (`d94d647`) stops recurrence.
- ✅ **Bounded status scan** (`59c9659`) — `listRuns` reads at most a recent-file window (`TERRARIUM_LIST_SCAN_WINDOW`), so status list-mode no longer scales with home size and can't be starved past the MCP deadline.
- ✅ **Post-timeout recovery filters** (`3f4ec73`) — `listRuns`/`terrarium_status` accept `channel`/`workflowId`/`sinceMs`, so a caller that lost its runId to a timeout re-associates the started run instead of relaunching.
- ⬜ **OPEN — durable accept-receipt before RPC wait** (hardening item 1 below): return `{ runId, status: "accepted" }` at the earliest durable point so the caller *always* leaves the spawn call with a runId, even if the launch handshake later exceeds the deadline. Not yet built.

## Symptom (from live dogfood)

`terrarium_spawn_batch` and `terrarium_spawn` returned MCP error `-32001 Request timed
out` **after accepting valid requests**. The first batch nevertheless started two
children — `ter_20260715150853089_xqde02` and `ter_20260715150853091_t31uri` — and both
later **completed OK**. A follow-up writer spawn returned the same timeout; then
`terrarium_status` also returned `-32001`.

The reporter correctly flags this as a **fail-closed orchestration bug**: work can start
while the parent receives no runId/receipt and cannot reliably query status — so the
parent cannot track, verify, or reap what it launched.

## Verified findings (this investigation)

1. **Work was durably recorded.** Both reported runs persisted metadata to
   `~/.terrarium/runs/<runId>.json` (both `status: done`). The runId was therefore
   *recoverable* the whole time — the caller just never received it because the RPC
   timed out before returning.
2. **The MCP handler already uses the launch-and-return path.** `terrarium_spawn`
   (background) calls `spawnTerrariumBackground` (src/core.js), which spawns a **detached
   supervisor** and returns at launch — it does NOT await run completion. So the timeout
   is in the *launch/handshake*, not a completion wait.
3. **Root cause of the launch/status slowness: operator-home bloat + concurrency.**
   The bloat-sensitive path is `readdir(LOG_DIR)` over the whole runs dir. This is hit by
   `listRuns` (line 991) and `pruneStaleChildClaims` (line 409) — and therefore by
   **`terrarium_status` in LIST mode (no runId)** and `terrarium_doctor`. Note:
   `getRunStatus(runId)` reads a *single* file (`readMetadata`), so status-BY-ID is not
   bloat-sensitive; the reporter's `terrarium_status` timeout was the list-mode path —
   exactly the recovery move a caller makes after losing a runId, which is why the failure
   compounds. The real home had accumulated **24,181 run files (1.8 GB)** from bare
   `node --test` runs bypassing the isolated test runner. Under a concurrent batch, these
   directory scans + general IO contention pushed operations past the MCP request deadline
   — the **same root cause** as the earlier `terrarium_doctor` timeout. Archiving the 24k
   files dropped `diagnose` ~800ms→230ms and `terrarium_doctor` no longer times out.
   Test-home isolation (test/setup-home.mjs, committed d94d647-era) prevents recurrence.

## Why it still matters after the bloat cleanup

The bloat cleanup addresses the *immediate* trigger, but the **architectural gap is real
and independent**: any time a spawn's launch handshake exceeds the caller's RPC deadline
(slow FS, load spike, cold start), the caller loses the runId even though the child
started. That is a fail-closed orchestration hole regardless of why the handshake was
slow.

## Proposed hardening (durable accept-receipt before RPC wait)

1. **Return the accept-receipt as early as possible.** The runId + logPath are known
   before any slow work (git info, workspace copy, metadata). Persist and return a minimal
   `{ runId, status: "accepted" }` receipt at the earliest durable point, then let the
   detached supervisor own the rest. The caller always leaves with a runId.
2. **Keep `terrarium_status`/`listRuns` fast and independently available during spawn
   load.** Bound or index the `readdir(LOG_DIR)` scan (paginate, or keep a recent-runs
   index) so a large/half-migrated store cannot push status past the deadline. Status must
   never share a failure mode with spawn.
3. **Recovery affordance for a lost RPC:** document (and/or add) "list my recent launches
   by channel/recency" so a caller that ate a timeout can re-associate the runId via
   `listRuns` filtered by channel + startedAt, rather than duplicating the work inline.

## Reproduction

Configured Pi gateway runner + default model (no explicit agent/model override); a
`terrarium_spawn_batch` of writer children under a bloated/contended `~/.terrarium/runs`.
Intermittent `-32001` on spawn and status while children start and complete durably.

## Immediate operator mitigation (already applied)

- Archived the 24,181-file / 1.8 GB runs backlog (reversible; workspaces untouched).
- Test-home isolation guard so bare `node --test` no longer pollutes the real home.
- Result: `terrarium_status`/`terrarium_doctor` fast again; spawn launch no longer
  contends on a giant directory scan.

## Do NOT

- Do not treat the timed-out RPC as "spawn failed" — the child may be running. Query
  `terrarium_status`/`listRuns` before relaunching, or a duplicate child is spawned.
