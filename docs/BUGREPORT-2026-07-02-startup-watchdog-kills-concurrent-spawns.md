# Bug Report — hard-coded 15s startup watchdog kills concurrent `terrarium_spawn` children, not just `_batch`

Date: 2026-07-02
Reporter: Jordan (via Pi session)
Severity: **high** (renders fan-out unusable above a handful of concurrent `pi -p` children)

## Summary
Fired 17 independent `terrarium_spawn` calls (not `_batch` — individual calls, all in
one turn) to run 17 short review children in parallel. **All 17 failed identically**,
each killed at ~17.15s–17.20s after start with `exitCode: 124` and
`error: "startup-timeout: child produced no output within 15000ms"`. Every mre log is
0 bytes — the children never emitted a single byte of output before being SIGTERM'd.

This was previously (this same session, 2026-07-01) misdiagnosed as a `_batch`-specific
issue ("terrarium_spawn_batch has a hard-coded ~15s startup-timeout"). It is not
batch-specific. It's a watchdog in the shared spawn path (`core.js`) that fires on any
background run, and it's trivially reproducible by firing several `pi -p --no-session`
children at the same moment — plain `terrarium_spawn` hits it exactly the same way
`_batch` does when called concurrently.

## Reproduction (100% reproducible)
1. Issue 17 `terrarium_spawn` calls in one turn, each: `agent: "pi -p --no-session"`,
   `profile: "minimal"`, `background: true`, `timeoutMs: 240000`.
2. Each child's task: read two files, apply a short persona/lens, write one findings
   file (~40 lines) to a given path. Bounded, simple, no network calls beyond the
   model provider itself.
3. Poll `terrarium_status` per `runId` ~30s later.

Result: 17/17 `status: "error"`, `exitCode: 124`,
`error: "startup-timeout: child produced no output within 15000ms"`,
`finishedAt - startedAt` clustered at **17.15s–17.20s** for every single one (i.e. the
15000ms watchdog plus ~2.1–2.2s of SIGTERM-to-persisted-finalize overhead — a tight,
uniform cluster, not 17 independently-random slow starts).

## Root cause (found in source)
`terrarium/src/core.js:826-831`:
```js
const startupWatchdogMs = Number(process.env.TERRARIUM_STARTUP_WATCHDOG_MS ?? 15000);
const startupWatchdog = startupWatchdogMs > 0 ? setTimeout(() => {
  if (!childOutputSeen && !finishing) {
    signalProcessGroup(child.pid, "SIGTERM");
    void log(run.logPath, `\nstartup-timeout: child produced no output within ${startupWatchdogMs}ms\n`);
    void observe({ type: "RuntimeError", exitCode: 124, error: `startup-timeout: child produced no output within ${startupWatchdogMs}ms` });
  }
}, startupWatchdogMs) : null;
```

- Hard-coded default **15000ms**, overridable only via the `TERRARIUM_STARTUP_WATCHDOG_MS`
  process env var on the terrarium server itself — **not** exposed as a `terrarium_spawn`
  / `terrarium_spawn_batch` tool parameter. A caller cannot raise it per-call.
- It is a completely separate timer from the caller's `timeoutMs` (that governs total
  run duration once output has started; this one governs *time to first byte of
  output at all*). Passing a larger `timeoutMs` does nothing to help — confirmed:
  all 17 had `timeoutMs: 240000` and still died at ~15s.
- The heuristic ("no stdout/stderr byte yet = presumed hung, kill it") is wrong for
  `pi -p` under concurrency: firing N children at once means N simultaneous model-provider
  cold starts (auth, tool discovery, first-token latency) competing for the same
  rate limits / local CPU. A `pi -p` child that is alive and working but simply hasn't
  printed anything yet looks identical to a genuinely stuck one under this heuristic.
  Liveness (process still running, not exited) is a materially different signal than
  "has it echoed a byte," and the code only checks the latter.

## Impact
- `terrarium_spawn_batch` was already known-broken for this (filed 2026-07-01).
- This report extends that finding: **plain `terrarium_spawn`, called individually but
  concurrently, hits the exact same wall.** There is currently no way to fan out more
  than a handful of `pi -p` children at once through terrarium without every single one
  dying before it produces its first line — which defeats the entire stated purpose of
  the tool for exactly the "spawn parallel reviewers" pattern `.context/TERRALOOP.md`
  recommends.
- Workaround used this session: fall back to raw `nohup pi -p --no-session &` background
  shell processes outside terrarium. This works but throws away everything terrarium is
  for (status polling, log reading, cancel-on-hang, durable callbacks, group roll-ups).

## Suggested fix directions
1. **Expose the watchdog as a real per-call parameter** (e.g. `startupTimeoutMs` on
   `terrarium_spawn`/`terrarium_spawn_batch`), not just a server-process env var baked
   in at terrarium-server-start time.
2. **Raise the default.** 15s is too aggressive for `pi -p` cold start even at
   concurrency=1 in some cases; at concurrency=17 it is guaranteed to fail every time.
   Something in the 45–90s range as a default would likely clear normal cold-start
   variance; still make it configurable per call.
3. **Prefer a liveness check over a silence heuristic** where feasible: is the child
   process (or its process group) still alive / consuming CPU, vs. exited/zombied.
   A slow-to-first-byte child and a hung child are not the same thing and the current
   watchdog cannot tell them apart.
4. **Reflect this in `terrarium_doctor`**: a burst of `startup-timeout` errors clustered
   in the same ~2s window across many runs is a distinct, diagnosable signature
   (systemic concurrency limit hit) that doctor could flag directly, separate from
   genuinely orphaned/stuck runs.

## Evidence (raw)
Run IDs (all identical failure mode): `ter_20260702113906488_04df0d`,
`ter_20260702113906490_lcv43d`, `ter_20260702113906489_7wls01`,
`ter_20260702113906489_i849pg`, `ter_20260702113906489_jll5x1`,
`ter_20260702113906489_o2ovsk`, `ter_20260702113906489_5y8xdf`,
`ter_20260702113906490_028k81`, `ter_20260702113906489_wplx0z`,
`ter_20260702113906490_ebqks2`, `ter_20260702113906490_n4q4kj`,
`ter_20260702113906490_k8cq3j`, `ter_20260702113906490_6nqmmc`,
`ter_20260702113906490_u6gam5`, `ter_20260702113906490_j5kzg7`,
`ter_20260702113906490_bksv3x`, `ter_20260702113906490_skmyeh`.

Sample full status (`ter_20260702113906488_04df0d`):
```json
{
  "status": "error", "ok": false, "exitCode": 124,
  "error": "startup-timeout: child produced no output within 15000ms",
  "startedAt": "2026-07-02T11:39:06.490Z",
  "finishedAt": "2026-07-02T11:39:23.670Z"
}
```
Corresponding mre log: **empty (0 bytes)** — zero output ever produced.

## Status (updated 2026-07-17): RESOLVED
Fixed in core across several commits:
- `befd22c` / `3a53701` — raised the too-tight default startup watchdog (15s was killing healthy cold starts).
- `d94d647` — **liveness-aware startup watchdog**: a live child (optionally also growing its run/mre log) is never killed by the base window; it dies only at an absolute hard ceiling (default 6×, `TERRARIUM_STARTUP_HARD_CEILING_MS`). The base window only fast-fails a dead-and-silent child. Per-spawn/per-job `startupWatchdogMs` is exposed over MCP. This is the exact false-kill (alive, log-growing, slow-first-stdout child reported here). Tests in `test/basic.test.js` (alive log-growing child survives; wedged-but-alive dies at ceiling).

The original "Not fixed / filed for handoff" note is superseded.
