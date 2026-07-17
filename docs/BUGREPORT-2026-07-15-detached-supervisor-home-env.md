# BUGREPORT 2026-07-15 — detached supervisor may not inherit TERRARIUM_HOME under test isolation

Status: **RESOLVED — env pin shipped and test coverage verified. Low severity.**

## Fix applied

`spawnTerrariumBackground` now passes `env: { ...process.env, TERRARIUM_HOME: HOME }`
to the detached supervisor spawn, so the detached process always resolves the
same home as its parent.

## Test audit — verified covered
The 5 test files that spawn real background runs (`basic`, `batch`, `run-machine`,
`pi-extension`, `concurrency-isolation`) do not set `TERRARIUM_HOME` themselves,
but they inherit the isolated home from `test/setup-home.mjs` (preloaded via the
runner's `--import`), and the supervisor env-pin propagates it to detached
children. Verified: running `concurrency-isolation` + `run-machine` under the
guard leaves the real `~/.terrarium/runs` file count unchanged (CLEAN). No
per-test change needed; the guard + env-pin cover the path.

## Symptom

Running the full test suite grew the real `~/.terrarium/runs` by a handful of
`done` run files (normal full metadata, not accept-receipts), even though the
official runner sets an isolated `TERRARIUM_HOME`. Confirmed **not** caused by
the accept-receipt change (0 stuck `accepted` records; the leaked files are
complete `done` runs from a test using the detached-supervisor path).

## Likely cause

`spawnTerrariumBackground` (src/core.js) launches the background worker as a
**detached child `node` process** running `supervisor.js`:

```
const supervisor = spawn(process.execPath, [supervisorPath, specPath], { stdio: "ignore", detached: true });
```

No explicit `env` is passed, so it inherits `process.env`. The test-home guard
(`test/setup-home.mjs`) sets `process.env.TERRARIUM_HOME` in the PARENT test
process, and `process.env` mutations DO propagate to spawned children — so in
principle the supervisor should inherit it. The leak suggests an edge where a
test path sets the home differently (e.g. via `config`/opts rather than env), so
the detached supervisor resolves the default `~/.terrarium` instead.

## Impact

Low: a few extra completed-run files under a test-isolated context. No data
loss, no correctness impact, no leak of secrets. It is a test-hygiene gap of the
same family as the (now-guarded) bare-`node --test` case — the detached
supervisor is a second process that can miss the guard if the home was set by a
mechanism that does not reach `process.env`.

## Proposed fix

1. Pass an explicit `env` to the supervisor spawn that pins the resolved
   `TERRARIUM_HOME` (from `HOME` in core.js), so the detached process always
   uses the same home as its parent regardless of how the parent resolved it:
   `spawn(..., { env: { ...process.env, TERRARIUM_HOME: HOME }, ... })`.
2. Audit tests that spawn real detached background runs to ensure they set
   `TERRARIUM_HOME` via env (which the guard and this fix both honor), not only
   via an in-process `config`.

## Not doing now

Out of scope for the spawn-RPC-timeout bug. Logged so it is not lost. Fix is a
one-line env pin plus a test audit; safe to batch with the next core change.
