# Bug report — 2026-07-24 — MCP spawn `-32001` timeout (git blocked the accept-receipt)

Two `terrarium_spawn` MCP calls returned `MCP error -32001: Request timed out`
before any runId, while the native CLI spawn succeeded. The reporter correctly
isolated the boundary to **MCP-tool spawn ack vs native CLI** and correctly
noted CPU starvation was contributory but not sufficient.

## Root cause (reproduced)

`prepareRun()` (src/core.js) runs `gitInfo(run.cwd)` **synchronously before the
durable accept-receipt is returned**, and `gitInfo` runs `git status --short`.
That git call was **unbounded**. Two things then compound:

1. The reported spawns used `cwd:/Users/jcoeyman/cloudflare/pantry` and
   `cwd:/Users/jcoeyman/cloudflare`. The latter is a **98GB tree**; `git status
   --short` there scans the whole working tree.
2. Leaked CPU-heavy pi processes (two 3-day-old runaways from closed cmux panes,
   one pegged at 100%+) starved the box, so even a normally-fast git blocked.

Either way, the unbounded git call inside prepareRun stalled the spawn past the
**MCP host's RPC deadline** → `-32001` with **no runId returned**. The native
CLI has no RPC deadline, so it just waited and eventually succeeded — the exact
MCP-vs-CLI boundary the report identified.

Confirmed: a fresh MCP server returned a background spawn in ~800ms when the box
was calm; the same path with `cwd:/cloudflare` (98GB) hung under load. Both MCP
server processes were `S+` idle at inspection — the server was never wedged; the
*spawn handler* blocked in git.

## Fix

Bound the git metadata call so it can never block the accept-receipt.

- `spawnCapture(cmd, args, { timeoutMs })` now kills the subprocess on timeout
  and resolves `{ code:124, timedOut:true }` instead of hanging (src/core.js).
- `gitInfo`'s git calls run under `GIT_INFO_TIMEOUT_MS` (default 3000ms,
  override `TERRARIUM_GIT_INFO_TIMEOUT_MS`). git metadata is advisory, so a
  timeout returns `null` metadata rather than blocking the spawn.

Verified: the exact failing case — background spawn `cwd:/Users/jcoeyman/
cloudflare` (98GB) — now returns a runId in **807ms** instead of timing out.
Regression test: `test/spawn-git-timeout.test.js` (3 tests: timeout kills +
marks, no-timeout unchanged, fast call not killed).

## The 4 hardening asks — status

1. **Spawn returns a durable accepted-run receipt before child work, or a
   structured failure.** The durable `accepted` record already exists (landed
   2026-07-15, core.js:453) and IS written inside prepareRun. The defect was
   that prepareRun could block in git *before* returning it. Fixed by bounding
   git. The remaining true gap — an MCP transport timeout still yields only a
   gateway error, not a structured incident id — is inherent to a synchronous
   RPC; the mitigation is (a) this git bound, (b) `background:true` (returns the
   runId at admission), and (c) the post-timeout recovery filters already in
   `terrarium_status` (channel/workflowId/sinceMs) to re-associate a runId lost
   to a timeout. A structured `incidentId` on transport timeout is a host-side
   (Pi MCP client) change, not a Terrarium-server one — noted for the host.

2. **Watchdog/preflight for host CPU starvation / stale pi.** NOT built yet —
   this is the genuinely new, high-value item. Design: a `host-capacity` check
   (loadavg vs cpu count; count of orphaned pi whose tty is not a live cmux
   surface) surfaced in `doctor` and as a spawn preflight warning. Deferred to a
   dedicated change; the git bound already removes the specific amplifier that
   turned starvation into a lost receipt. (The starvation itself was cleared by
   reaping the leaked processes; detector recorded: `pi` procs whose tty is
   absent from `cmux tree --all`.)

3. **doctor reports MCP-process vs CLI-process effective env separately.**
   Partially exists (`diagnoseStaleCloudEnv` flags a config-vs-process cloudUrl
   split). Surfacing both environments' effective cloud/pulse config side by
   side is a small addition — deferred with #2.

4. **Integration test for delayed spawn ack / recovery.** Added
   `test/spawn-git-timeout.test.js` (the mechanism-level test). A full
   delayed-ack-over-MCP integration test is a follow-on.

## Honesty note

The report was right on every count: MCP-vs-CLI is the real boundary; starvation
was contributory not sufficient; the failure gave no receipt. The sufficient
cause was the **unbounded synchronous git call in the accept path** — starvation
just made a normally-invisible blocking call cross the RPC deadline. Fixed the
amplifier (git bound); the starvation source (leaked pi) was reaped; items 2 and
3 (capacity watchdog + dual-env doctor) remain as named follow-ons.
