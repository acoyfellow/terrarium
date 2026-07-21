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

### Root cause (THREE layers — all three must be fixed)

#### Layer A — server-side: `ownerId` stripped from the routed event (the primary cause)
The live worker's `RunControlDO.#emitToPulse` attaches `event.ownerId` (the run's
principal) and calls the Pulse DO `route` with `requirePrincipalOwner: true`. But
`ALLOWED_EVENT_FIELDS` in src/pulse/shared.js did NOT include `ownerId`, so
`route()`'s `sanitizeCallbackEvent()` STRIPPED it, then the
`PRINCIPAL_ID_RE.test(routed.ownerId)` gate threw `invalid callback event`. The emit
fails soft, nothing is journaled, and NO subscriber (wildcard OR concrete) ever
receives the terminal event. Proven by simulation: with the live allowlist,
`ownerId` sanitizes to `undefined` and the gate throws; with `ownerId` added it
survives and the gate passes. FIX: add `ownerId` to `ALLOWED_EVENT_FIELDS` +
`validOwnerId` (Round 5C2). REQUIRES A CLOUD DEPLOY.

#### Layer B — extension: wildcard `pi-*` subscription is refused by design
The autocontinue extension's cloud-pulse feed
(~/.pi/agent/extensions/terrarium-autocontinue.ts) is gated on the `PULSE_TOKEN`
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

Even with the token, the cloud subscriber id is `pi-cloud-<hash>` and it subscribed
with `runIds: ["*"]`. The Pulse matcher (src/pulse/shared.js `matches()`) has a guard:
`if (/^pi[-_]/.test(subscriberId) && runs.includes('*')) return false;` — a wildcard
`pi-*` subscriber is denied ALL delivery by design (so a session can't wildcard-claim
every principal's runs). So even after Layer A, the extension's wildcard cloud
subscribe receives nothing. A dedicated test asserts this exact behavior.

#### Layer C — extension: pulse token not resolved from disk
`PULSE_TOKEN` env is unset in the session, so `cloudEnabled()` was false and the feed
never ran — even though the credential is on disk and mcp.json already sets
`TERRARIUM_PULSE_TOKEN_FILE`.

### Fixes
1. **Server (deploy):** `ownerId` added to `ALLOWED_EVENT_FIELDS` + `validOwnerId`
   validator in src/pulse/shared.js so the routed event keeps its owner and the
   `requirePrincipalOwner` gate passes. Terminal events are journaled and fan out.
2. **Extension (token):** resolve the pulse token via a fallback chain mirroring the
   MCP client — env `PULSE_TOKEN` -> env `TERRARIUM_PULSE_TOKEN` ->
   `~/.terrarium/config.json` `pulseTokenFile` -> `~/.terrarium/secrets/prod-pulse-token.secret`.
3. **Extension (concrete runIds):** `cloudSubscribe` now subscribes to the CONCRETE
   spawned run IDs (the same set the local fs path tracks), never `["*"]`, dodging the
   `pi-*` wildcard guard; re-fired on each spawn as the runId set grows, with an
   immediate poll (replay covers finish-before-subscribe).

## Verification
- Bug 1: unit assert that a filesystem-dependent cloud batch refusal survives
  `conciseBatch` with `phase`/`code`/`error` intact.
- Bug 2: extension resolves the on-disk pulse token when env is unset; cloud feed
  becomes enabled.
