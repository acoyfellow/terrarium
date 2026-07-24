# Bug report — 2026-07-23 — local runs unreadable (by-id ops misrouted to cloud)

A Terraloop driver launched background children, got `ok:true` + `status:running`
+ runIds, then every `terrarium_read`/`terrarium_status` returned "run not found
on cloud instance". The parent could not verify child work and stopped at its
safety boundary. Correct behavior by the driver; real bug in the router.

## Root cause (ONE bug, not the six suspected)

The four runs were **local** runs (the spawn had `cwd:/Users/jcoeyman/cloudflare/
pantry`, so it correctly routed to the local backend and ran on-box — confirmed:
the records exist in `~/.terrarium/runs/`, with real pids and logs). The bug is
purely in **by-id read/status/cancel routing**:

```js
// before (src/mcp.js) — every by-id op:
if (args.runId && (isCloudRunId(args.runId) || cloudEnabled())) { ...cloud... }
```

`cloudEnabled()` is true (cloud is the default backend), so the `|| cloudEnabled()`
clause forced EVERY by-id read/status/cancel to the cloud instance — even for a
local-shaped runId that `isCloudRunId()` correctly rejects. The local run existed
and was readable on disk; the router just never looked there.

- Local runId shape: `ter_20260723231728312_psra35` (17-digit timestamp, non-hex tail)
- Cloud runId shape: `ter_mrw01ze_987bb8e54018` (base36) — `isCloudRunId` regex `^ter_[a-z0-9]{6,10}_[a-f0-9]{8,}$`

`isCloudRunId` already distinguishes them correctly (local → false, cloud → true).
The `|| cloudEnabled()` override was the defect.

## The fix

Route a **by-id** op by the runId's SHAPE, not by whether cloud is configured.
`terrarium_status`, `terrarium_read`, `terrarium_cancel`, and
`terrarium_report_failure`:

```js
if (args.runId && isCloudRunId(args.runId)) { ...cloud... } else { ...local... }
```

List-mode (`terrarium_status` with no runId) still uses the cloud index when
cloud is the default — that is correct; only by-id lookups were misrouted.

Verified: the four "unreadable" runs from this report are now fully addressable
via the MCP — `terrarium_status` returns the real record (`failed`, exit 1),
`terrarium_read` returns the local log. Regression test:
`test/mcp-byid-routing.test.js`.

## Triage of the report's other claims (honest: what was real vs not)

The report listed six suspected areas. Only one was the real cause:

- **#2 Local/cloud namespace mismatch — CONFIRMED, fixed above.** This is the bug.
- **#1 Run registration race — NOT the cause.** The local run was registered and
  readable immediately; spawn did not return before registration. (For local
  runs a durable `accepted` record is written before launch.)
- **#3 Callback persistence — separate, pre-existing.** The doctor's
  `missingTerminalCallbacks: 13` is real accumulated cruft, not caused by this
  spawn. `terra doctor --repair --apply` recovers them (idempotent). Not new.
- **#4 Lineage visibility — NOT the cause.** These were top-level runs; scope was
  not the issue. Read failed on routing, before any scope check.
- **#5 Supervisor cleanup / orphans — pre-existing cruft.** `orphanedRuns: 11`
  includes the 4 never-launched 98GB-copy runs from an earlier session plus
  older ones. `terra doctor --repair` reconciles them.
- **#6 Workspace leak — pre-existing.** `leakedWorkspaces: 5` predates this;
  `doctor` already reports it; repair prunes it.

So: the report is accurate that the parent could not verify, and right to stop.
The single code defect is the by-id cloud-routing override. The doctor findings
are real but are accumulated state a repair pass clears, not consequences of
this spawn.

## The report's "additional observation" (batch task-contract)

The earlier batch returning `taskContractStatus: missing` is the SAME cloud
child-model receipt issue documented in
`BUGREPORT-2026-07-21-receipt-runid-mismatch-cloud-model.md` (the fixed cloud
model does not reliably echo the contract). The batch wrapper rejecting those is
correct (fail-closed). Individual local spawns with explicit contracts then ran
fine locally — they were only unreadable due to the routing bug, now fixed.

## On the report's suggested fixes (what we adopted vs deferred)

- "Ensure the returned runId is valid across spawn/read/status/callbacks/cancel"
  — ADOPTED (the routing fix; a runId now resolves on the backend that owns it).
- "Repair command for orphans/missing-callbacks/leaked-workspaces, idempotent,
  machine-readable receipt" — ALREADY EXISTS: `terra doctor --repair --apply
  --verify` (recover/requeue/prune + residual evidence). Pointed the operator at it.
- "Add runStore/registeredAt/readEndpoint to the spawn response" — deferred; the
  shape fix makes routing correct without a schema change. A `runStore:"local|
  cloud"` hint is a cheap follow-on if callers want it explicit.
- "Do not report ok:true if the parent cannot later address the run" — now moot:
  the parent CAN address it; ok:true was truthful, the reader was wrong.
