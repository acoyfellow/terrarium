# Bug report — 2026-07-21

Found live in a cmux Pi session (workspace 1BFABFE8, surface 30360686) running a
4-persona adversarial review via terrarium cloud spawns. Two independent bugs.

## Bug 1 — `terrarium_spawn_batch` returns opaque `{"ok": false}` (cloud path)

### Symptom
A batch of 4 jobs (each referencing a local file `/tmp/scan/ARTIFACT.md`) returned
exactly:

```json
{ "ok": false }
```

with no `phase`/`code`/`error`. The MCP layer then printed the full parameter schema,
which read as a *validation* rejection. The operator wasted a retry (dropping `agent`
+ `timeoutMs`) chasing a schema problem that did not exist. Single `terrarium_spawn`
worked fine, which further pointed the blame at the batch schema.

### Root cause
The real refusal came from `cloudSpawnBatch()` (src/cloud-client.js:255): the jobs were
filesystem-dependent (they read a local path the cloud cell can't see), so it returned:

```json
{ "ok": false, "phase": "preflight", "code": "filesystem-dependent",
  "cloud": true, "error": "cloud batch refused: 4 job(s) need the local filesystem…",
  "filesystemDependentJobs": [0,1,2,3] }
```

That rich object is correct. But the MCP handler projects it through `conciseBatch()`
(src/mcp.js:292) before returning, and `conciseBatch` did NOT copy `phase`, `code`,
`error`, or `filesystemDependentJobs`. Every diagnostic field was stripped, leaving a
bare `{ok:false}`. (`reason` was projected, but the cloud preflight refusal uses
`phase`/`code`/`error`, not `reason`.)

The single-spawn path never hit this because `cloudSpawn` errors are surfaced by a
different projector that preserves the message.

### Fix
`conciseBatch()` now projects `phase`, `code`, `error`, and `filesystemDependentJobs`.
A refused batch is now self-describing and the operator learns the actual reason
(inline the file contents, or run with TERRARIUM_ALLOW_LOCAL=1).

## Bug 2 — cloud background spawns finish but never wake the Pi session

### Symptom
Four `terrarium_spawn background=true` cloud runs all reached `done`/`ok:true`, but no
terminal callback woke the session. The operator waited ("hmm, i expected callbacks by
now"), then had to manually `terrarium_status` + `terrarium_read` all four runIds. The
spawn tool description explicitly promises "The Pi extension will surface each terminal
callback here as they finish" — that promise silently failed for cloud runs.

### Root cause
The autocontinue extension's cloud-pulse feed
(~/.pi/agent/extensions/terrarium-autocontinue.ts:54) is gated on the `PULSE_TOKEN`
env var:

```ts
const PULSE_TOKEN = process.env.PULSE_TOKEN || '';
const cloudEnabled = () => PULSE_TOKEN.length > 0;
```

`PULSE_TOKEN` is not exported in this session's env, so `cloudEnabled()` is false and
the cloud feed never subscribes — even though the credential exists on disk at
`~/.terrarium/secrets/prod-pulse-token.secret` and `~/.terrarium/config.json` already
points the MCP client at the cloud. The local FS router feed only carries LOCAL runs;
cloud terminal events land in the cloud Pulse mailbox that nobody is polling. Result:
cloud background spawns are fire-and-forget with no wake — exactly the poll-free path
the tool tells you to rely on.

This is the same class as the earlier directTools/config bug: the credential is on the
box but the running process never inherited it, and nothing falls back to the config
file / secret file.

### Fix
The extension now resolves the pulse token with a fallback chain mirroring the MCP
client's `cloudConfig`/`pulseConfig`:
1. `process.env.PULSE_TOKEN` (unchanged, highest priority)
2. `process.env.TERRARIUM_PULSE_TOKEN`
3. `~/.terrarium/config.json` `pulseTokenFile`
4. `~/.terrarium/secrets/prod-pulse-token.secret` (conventional default)

With any of these present, the cloud feed subscribes and cloud terminal callbacks wake
the session, matching the documented behavior.

## Verification
- Bug 1: unit assert that a filesystem-dependent cloud batch refusal survives
  `conciseBatch` with `phase`/`code`/`error` intact.
- Bug 2: extension resolves the on-disk pulse token when env is unset; cloud feed
  becomes enabled.
