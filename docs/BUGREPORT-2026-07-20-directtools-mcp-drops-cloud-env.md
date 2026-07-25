# BUGREPORT 2026-07-20 — direct-tools MCP resolves with NO cloud env, walling every real spawn

Status: **OPEN — needs owner. Blocks all orchestration from this Pi session.**

Filed by: Pi session in `/Users/jcoeyman/cloudflare` (workspace_id 4AF51288-6D9A-4D7E-B38D-07FCC90BECA9), mid "Liquify Jordan's CFSA board" terraloop. Reporter is the ORCHESTRATOR and cannot spawn children — the loop is stalled at the layer, not the task.

## Severity
HIGH — `terrarium_spawn` cannot execute a single real child from this session. Dry-run succeeds (it skips the env gate), so the failure is invisible until a real task runs — which produced a false "spawn is up" reading earlier this session.

## Symptom
- `terrarium_spawn` (real, non-dryRun) errors:
  `Terrarium runs on Cloudflare by default: set TERRARIUM_URL and TERRARIUM_CONTROL_TOKEN (or TERRARIUM_TOKEN_FILE) to run in the cloud. To run locally set TERRARIUM_ALLOW_LOCAL=1.`
- `terrarium_spawn { dryRun:true }` → **succeeds**, resolves `model: gpt-5.6-terra` and the full child invocation. (False positive: dryRun bypasses the env gate.)

## Root cause (confirmed via doctor)
`terrarium_doctor` on this session reports:
```
cloudConfigured:   false
configuredCloudUrl: null
processCloudUrl:    null
pulseConfigured:   false
staleCloudEnv:     false
```
…even though `~/.pi/agent/mcp.json` registers terrarium with:
```json
"terrarium": {
  "command": "node",
  "args": ["/Users/.../node_modules/terrarium/src/mcp.js"],
  "directTools": true,
  "env": {
    "TERRARIUM_URL": "https://terrarium.coey.dev",
    "TERRARIUM_TOKEN_FILE": "/Users/jcoeyman/.terrarium/secrets/prod-token.secret",
    "TERRARIUM_PULSE_TOKEN_FILE": "/Users/jcoeyman/.terrarium/secrets/prod-pulse-token.secret"
  }
}
```

**The `env` block declared in `mcp.json` is not applied to the direct-tools
in-process instance.** With `directTools: true`, terrarium runs inside the Pi
host process and inherits the *host* env — which has `TERRARIUM_URL`,
`TERRARIUM_CONTROL_TOKEN`, and `TERRARIUM_TOKEN_FILE` all empty (session started
before the Jul 18 cloud config landed). So the MCP resolves neither cloud
(no URL/token in process env) nor local (`TERRARIUM_ALLOW_LOCAL` empty) → wall.

Verified out-of-band, all healthy:
- Token files present + non-empty: `prod-token.secret`, `prod-pulse-token.secret` (Jul 18).
- Cloud endpoint reachable: `GET https://terrarium.coey.dev/health` → **200**.
- `~/.terrarium/.env` has `TERRARIUM_ALLOW_LOCAL=1` — **not read** by the process.

## Impact
Orchestration is impossible from this session. Worse: the previous session's
operator (this same agent) misread "spawn down" as license to demote itself to
worker and do ticket code inline for multiple ticks — a hygiene failure the
broken layer directly enabled. A down orchestration layer should HARD-STOP and
escalate, not silently degrade to inline work.

## Proposed fixes (owner to choose)
1. **Apply `mcp.json` `env` to direct-tools instances.** When `directTools:true`,
   the declared `env` block is currently dropped; it should be merged into the
   in-process config resolution (or at minimum `TERRARIUM_URL`/token-file paths
   should be honored from the registration, not only from `process.env`).
2. **Fail the dry-run the same way a real run fails** when no cloud/local target
   resolves — so `dryRun` can't report a false-positive "up". Or have doctor's
   `ok:false` short-circuit spawn readiness checks callers rely on.
3. **Session bootstrap**: relaunch Pi with the cloud env exported so
   `process.env` carries `TERRARIUM_URL` + token-file paths (workaround, not a fix).

## Also observed (pre-existing, lower severity — not this bug)
- 7 orphaned runs (`ter_20260717...`, `ter_accept_stale`) — lost supervisor pre-terminal.
- 229 malformed acknowledged callbacks flagged for quarantine/repair (`routerRepairCandidates: 229`).
- 8 leaked isolation workspaces survived terminal runs without `keepWorkspace`.

---
## RESOLVED — fixed in 46ea083 (2026-07-20)
`cloudConfig()` now falls back to `~/.terrarium/config.json` (cloudUrl + tokenFile/controlToken)
when env vars are absent; env still wins, fail-closed preserved, malformed config never throws.
`cloudUrl`+`tokenFile` written into the real `~/.terrarium/config.json` (backup
`config.json.bak-2026-07-20`). doctor.js false-positive corrected (empty process env is no longer
"stale/reload"; only a differing process URL is stale). 45/45 tests across cloud-client,
cloud-config-fallback (7 new), doctor, doctor-repair.

Verified from the ORIGINAL cached-env Pi session (no reload/restart):
- doctor: cloudConfigured **true**, configuredCloudUrl **https://terrarium.coey.dev**.
- real inline spawn: **ok:true, status:done, taskContractStatus:verified** (ter_mrtd08fz_ccce86b3737c).
- local-path spawn now hits the grounded-refusal guardrail (auth works) instead of the env wall.

Residual (separate from this bug): pulseConfigured:false ⇒ background cloud callbacks undeliverable
until TERRARIUM_PULSE_TOKEN(_FILE) is set + /reload; use synchronous or local isolation:copy meanwhile.
Deeper host-side fix (Pi applies mcp.json env to directTools instances) belongs upstream in the Pi harness.
