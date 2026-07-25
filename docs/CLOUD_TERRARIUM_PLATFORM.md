# Cloud Terrarium platform decision

Status: decision recorded and local detached E2E proof passed. Architecture-discovery P0/P1s are closed; next work is implementation of the first real Sandbox/Containers backend adapter, not deployment.

## North star

Find the smallest Cloudflare-native substrate for cloud Terrariums / facet cells that can scale massively while preserving Terrarium's operational truth:

```text
one bounded task -> one execution cell -> one correlated receipt -> durable wake event
```


## Decision

Use a **hybrid cloud Terrarium architecture**:

```text
Ordinary Durable Object run control cell
  + pluggable execution backend (first fake local, then Cloudbox/Sandbox/Container)
  + Pulse terminal wake transport
  + Workflows/Queues later for parent batch orchestration
```

Do **not** choose Cloudbox-only, Sandbox/Containers-only, Pulse-only, Workflows-as-runtime, or Facets-first.

Facets remain an optional follow-up only when dynamic/untrusted runner code or mediated authority is the thing being tested. The first prototype should use an ordinary DO-shaped `TerrariumRunCell`.

## Scorecard

| Candidate | Best role | Fit | First blocker | Decision |
| --- | --- | --- | --- | --- |
| Cloudbox | Product-shaped execution/artifacts/proof page | High for execution | Detached status/log tail/cancel semantics, Terrarium receipt verifier | Candidate execution backend after adapter proof |
| Sandbox / Containers | Raw bounded process/computer execution | High for execution | Explicit cancel with partial logs + terminal receipt | Candidate execution backend after supervisor proof |
| Ordinary Durable Objects | Per-run control state, idempotency, receipt refs, Pulse emission | High for control | Must delegate actual execution | Default control-cell substrate |
| Dynamic DO / Facets | Mediated dynamic authority, plugin/runner code cells | Medium/situational | Beta complexity; not needed for first control proof | Later optional experiment |
| Workflows / Queues | Parent orchestration, retry envelope, N-job dispatch/reduction | High for batch parent | Not proof authority; not single-run runtime | Add after run-cell proof |
| Pulse | Durable terminal wake transport | High for wake | Not execution/proof/memory | Keep as wake layer |

## Current evidence

### E2 — Sandbox SDK / Containers mapping

Run: `ter_20260701084838489_yrwgan`

Verdict: **viable execution substrate, not a full Terrarium by itself.**

Cloudflare Sandbox/Containers can plausibly run bounded child commands, but Terrarium still needs a durable control plane for status/read/cancel/receipt validation and Pulse terminal wake emission.

Evidence inspected by child:

- `cloudbox/src/cloudbox-sandbox.ts`
- `cloudbox/src/sandbox-computer.ts`
- `cloudbox/src/container-runner.ts`
- `cloudbox/src/runner-lifecycle.ts`
- `cloudbox/src/http-personal-computers.ts`
- `spawn-agent-cloud/src/Sandbox.ts`
- `ffmpeg-container/src/index.js`
- `molt/src/worker.ts`
- `cf-containers-drift-repro/package.json`

Mapping:

| Terrarium backend concern | Sandbox / Container evidence | Decision |
| --- | --- | --- |
| Start / bounded execution | `@cloudflare/sandbox` exposes `exec(command, { cwd, timeout, env, origin })`; Containers examples expose HTTP-backed container classes. | Supported. |
| Logs / read tail | Cloudbox captures `stdout`/`stderr`; platform observability exists. Streaming/tail needs app-level chunk persistence. | Partial; build app-level log capture. |
| Receipt | Cloudbox receipt shape maps to `cmd/code/signal/stdout/stderr/timestamps`. | Supported at app layer; must add runId/taskFingerprint/nonce validation. |
| Cancel | Timeout and container deletion exist; explicit child process-group cancel with partial logs and terminal receipt is not proven. | Main gap. Needs supervisor proof. |
| Durable status/read/cancel | Not owned by container itself. | Should live in DO/Facet control cell. |
| Pulse wake | Not provided by execution substrate. | Emit after receipt commit. |

Scaling expectations:

| Scale | Expected risk |
| --- | --- |
| 10 cells | Straightforward. |
| 100 cells | Startup latency/readiness polling matters. |
| 1k cells | Account limits, image startup, log/artifact volume, and DO/container instance limits dominate. |
| 10k cells | Needs queues/admission control/pooling; one warm container per run is likely too heavy. |

Smallest E2 prototype:

1. `POST /runs` creates one DO-controlled run.
2. DO starts one Sandbox/Container command with timeout.
3. Runner captures stdout/stderr incrementally.
4. `GET /runs/:id/status`, `GET /runs/:id/logs`, `POST /runs/:id/cancel`.
5. Terminal path writes a Terrarium-style receipt with `runId`, `taskFingerprint`, `nonce`, command exit/signal, timestamps, and log refs.
6. DO emits one terminal wake event after receipt commit.
7. Test: echo success, timeout, explicit cancel.

Open E2 gap: **prove explicit cancellation with partial logs and terminal receipt.**


### E1 — Cloudbox backend mapping

Run: `ter_20260701084832902_od6xnb`

Verdict: **strong product fit for execution/artifacts, but missing Terrarium-grade detached status/log/cancel semantics.**

Cloudbox already has the closest product shape to a cloud Terrarium computer: repo run, command receipts, runner lifecycle receipts, artifacts, diffs, live workspace operations, D1 run index, and R2 snapshots. It should be treated as a candidate execution backend, not as the whole Terrarium proof/control plane.

Mapping:

| Terrarium backend concern | Cloudbox evidence | Decision |
| --- | --- | --- |
| Start | `POST /api/runs`, `runInContainer`, live and batch run paths. | Good candidate. Batch path appears synchronous; Terrarium needs detached start. |
| Read/status | `GET /api/runs/:id`, live `read`, `exec`, D1 row/result. | Good for completed/live workspace state; missing first-class in-progress log tail. |
| Cancel | live `DELETE`, `stop`, snapshot/delete lifecycle. | Not equivalent to active bounded task cancellation with terminal receipt. Gap. |
| Receipt collection | command/verify receipts include command, code, signal, stdout/stderr, timestamps. | Useful evidence; Terrarium adapter must verify `TERRARIUM_RESULT` runId/taskFingerprint/nonce. |
| Artifacts | artifact, diff, public proof page, R2 snapshots. | Strongest candidate for artifact/diff proof pages. |
| Pulse wake | not native. | Emit from Terrarium/DO adapter after receipt verification. |

Exact Cloudbox gaps:

1. Async detached start/status split for batch proof.
2. First-class active-run cancellation with SIGTERM/SIGKILL semantics and partial logs.
3. Terrarium receipt-contract verification; Cloudbox `ok` is not Terrarium success.
4. First-class stdout/stderr tail for in-progress bounded runs.
5. Pulse terminal wake event.
6. Terrarium lineage/owner scope mapping.
7. Terminal state model mapping (`done/failed/cancelled/orphaned/...` vs Cloudbox statuses).
8. Artifact/log size and retention refs; D1 result truncation means logs/artifacts need R2 refs/digests.
9. 10k-cell scale requires queueing/backpressure/capacity measurement; current Cloudbox public/default capacity is intentionally small.

Smallest E1 prototype:

1. Add a Terrarium-side `CloudboxBackend` adapter; do not mutate Cloudbox first.
2. Start with a public GitHub fixture and `POST /api/runs`.
3. Run a command that prints exact `TERRARIUM_RESULT=...` and writes a small artifact.
4. Adapter maps Cloudbox receipts to Terrarium metadata only if receipt validation passes.
5. Emit a Pulse terminal event after adapter verification.
6. Follow-up live-run prototype tests log tail and whether delete/stop actually cancels a long-running command.

Key warning: **never treat Cloudbox `ok` as Terrarium `ok` until the Terrarium task contract verifies.**


### E5 — Hybrid architecture synthesis

Run: `ter_20260701084853619_c62whr`

Verdict: **likely winner is a Facet/DO control cell + pluggable execution backend + Pulse wake transport.**

Scorecard criteria:

1. Terrarium primitive fidelity.
2. Execution ownership: process/container/computer, logs, exit status, timeout, hard cancel.
3. Receipt truth: verified run/task-correlated receipt; exit 0 is not task success.
4. Status/read/cancel parity.
5. Wake durability through Pulse-compatible terminal events.
6. State locality and recovery: one authoritative control cell per run/facet.
7. Scale shape at 10 / 100 / 1k / 10k cells.
8. Operational simplicity.
9. Product-code deletion.
10. Prototypeability locally before deploy.

Recommended architecture:

```text
client / parent
  -> TerrariumFacet control cell
       owns task contract, run state, backend handle, receipt ref, status/read/cancel API
       delegates execution to backend adapter
  -> Cloudbox or Sandbox/Containers execution cell
       owns bounded process/computer/container, logs, artifacts, exit
       returns backend receipt fragment
  -> Pulse
       durable terminal wake event with small decide payload
```

Rejected paths:

| Path | Reason rejected |
| --- | --- |
| Cloudbox-only | Good execution/artifact substrate but not Terrarium's durable control/proof/wake plane. |
| Sandbox/Containers-only | Strong execution cells, weak orchestration/wake/state layer. |
| Workflows/Queues as primary runtime | Good for N-job orchestration/reduction, but risks turning Terrarium into a workflow engine. |
| Pulse-only | Wake transport, not execution, memory, workflow, or proof. |
| Single giant DO | Serializes state but cannot own process execution or high-scale logs/artifacts. |
| Rewrite Terrarium engine now | Premature; prove adapters/prototypes first. |

Exact next local E2E prototype:

```text
spawn request
  -> local TerrariumFacet in-memory/Miniflare DO-shaped controller
  -> fake execution backend starts one local child process
  -> controller captures status/log/exit/backend receipt
  -> controller verifies run/task correlation
  -> controller emits Pulse terminal event to local Pulse harness
  -> consumer claim/ack receives terminal event with small receipt
```

Acceptance checks:

- One task creates exactly one facet/run record and one execution handle.
- Status transitions pending/running/done or failed.
- `read` returns bounded logs or log refs.
- `cancel` terminates backend handle and emits terminal cancelled event.
- Completion requires correlated receipt, not exit 0.
- Pulse claim receives terminal event and receipt; ack is idempotent.
- Finish-before-subscribe replay works.
- Cross-owner claim/status fails closed.
- Backend adapter can later swap fake process for Cloudbox or Sandbox.

Suggested prototype files:

- `src/cloud/facet.js` or `src/facet/local-controller.js`
- `src/cloud/backend-fake-process.js`
- `test/cloud-facet-local-e2e.test.js`


### E4 — DO / Dynamic DO / Facets control-cell mapping

Run: `ter_20260701084848263_a8h7u5`

Verdict: **ordinary Durable Objects are the default control-cell substrate; Facets are optional for mediated dynamic authority, not the first implementation.**

A `TerrariumRunCell` / `TerrariumFacet` should be a per-run durable control cell keyed by `runId` or `taskFingerprint+nonce`. It owns Terrarium's authoritative state and delegates execution to Cloudbox/Sandbox/Container/other compute.

Control cell owns:

- task contract: `runId`, `taskFingerprint`, `nonce`, parent/channel/workflow/session, backend, timeout, limits, schema version;
- lifecycle state: `queued | starting | running | cancelling | terminal`;
- terminal state: `done | failed | timed_out | cancelled | inconclusive`;
- execution refs, lease/heartbeat, attempts, timestamps;
- receipt refs/digests, log refs, artifact refs, backend runner receipts;
- cancellation intent/token;
- idempotent Pulse terminal event after receipt storage/verification.

Control flow:

```text
POST /runs
  -> validate task contract
  -> idFromName(runId) -> RunCell.submit(contract)
  -> store contract/state=queued
  -> backend.start(contract)
  -> store executionRef/state=running

GET /runs/:id/status
GET /runs/:id/read
POST /runs/:id/cancel

backend terminal callback or reconcile/alarm
  -> cell.collect(executionRef)
  -> verify child receipt: runId/taskFingerprint/nonce
  -> store receipt/log/artifact refs
  -> state=terminal
  -> emit Pulse event exactly once
```

Why ordinary DO first:

- Terrarium needs serialized state, idempotency, status/read/cancel, receipt refs, and Pulse wake emission.
- Existing PulseRouter DO already proves the needed pattern: journal, mailbox, replay, dedup, owner checks.
- The control cell should not run long child processes; execution is delegated.
- Facets add beta/dynamic-code complexity without removing core product code for the first proof.

Where Facets may help later:

- dynamic/untrusted runner or plugin code;
- per-run policy adapters loaded dynamically;
- mediated authority where parent holds secrets/capabilities and dynamic facet only gets proxied access;
- customer-supplied control logic.

Smallest E4 prototype:

1. Implement a local Miniflare ordinary DO `TerrariumRunCell`.
2. Stub execution backend returns logs + Terrarium-style receipt after delay.
3. Exercise submit/status/read/cancel/collect.
4. Verify terminal receipt refs are stored before Pulse emit.
5. Prove duplicate collect emits only one Pulse event.
6. Only repeat with Facets if dynamic code + mediated authority is required.

Scale/failure notes:

- 10/100 cells: one DO per run is straightforward.
- 1k/10k cells: pressure shifts to execution backend capacity, log/artifact volume, alarms/polling, and Pulse sharding/fanout.
- Avoid one global run DO. Use per-run cells plus index/listing if needed.
- Cell must reconcile by `executionRef` after restart and emit Pulse once.


### E3 — Workflows / Queues orchestration mapping

Run: `ter_20260701084844370_zk2bv3`

Verdict: **Workflows/Queues are promising for parent orchestration and dispatch, not for per-run receipt truth.**

Best split:

| Concern | Owner |
| --- | --- |
| Parent orchestration, retry envelope, join/reduce state, timeout policy, audit | Workflows |
| Scalable dispatch/backpressure for facet jobs | Queues |
| One bounded task -> one execution cell -> one correlated receipt | Terrarium run cell / DO control cell |
| Terminal wake replay/claim/ack | Pulse |

Proposed `FacetBatchWorkflow` experiment:

1. Start parent workflow with `{parentRunId, workflowId, facets: N, strategy, quorum?, concurrency}`.
2. Create deterministic `facetJobId = sha256(parentRunId + facetIndex + taskFingerprint)`.
3. Enqueue N facet execution messages.
4. Each Queue consumer starts or coordinates exactly one facet execution cell.
5. Each facet emits terminal Pulse event with `{runId, parentRunId, workflowId, taskFingerprint, status, exitCode, receipt}`.
6. Parent workflow reduces terminal facts into `all`, `allSettled`, `race`, `any`, or `quorum`.
7. Winner strategies emit cancellation intent for remaining jobs/runs.
8. Parent emits one terminal wake event after finalization.

Retry/idempotency requirements:

- Queue delivery is at-least-once; every facet message must be idempotent.
- `facetJobId` prevents duplicate execution starts.
- Terminal facts keyed by facet/run ID must be counted once.
- Re-emitting a terminal event must be safe through Pulse dedup.
- If a consumer crashes after execution but before terminal emit, recovery must inspect execution/receipt state and emit/recover the event.
- Late terminal events after parent finalization are recorded but do not change the parent decision.
- Poison queue messages map to explicit failed/poison facet state, not silent retry loops.

Smallest E3 local experiment:

- Mock `FacetBatchWorkflow` with N=5 or 10 fake facet jobs.
- Simulate duplicate queue messages and duplicate terminal events.
- Simulate crash after execution before terminal emit.
- Reducer asserts:
  - each facet counted once;
  - parent finalizes once;
  - duplicate terminal events ignored;
  - quorum/race cancellation intent idempotent;
  - final parent receipt references verified child receipts.

Decision: use Workflows later for cloud batch parent orchestration, not as the single-run runtime or proof authority.


## Missed platform spikes

### E6 — Dynamic Workflows deep spike

Run: `ter_20260701090544038_uc75xq`

Verdict: **Dynamic Workflows strengthen the parent orchestration story; they do not replace per-run control cells or receipt authority.**

Evidence included local `docs/DYNAMIC_WORKFLOW_SKETCH.md`, `TerrariumCampaignWorkflow` in `src/control-worker.js`, and internal `cfi` research. The important shape is dynamic fanout with stable job IDs, signal/wait or parked workflow semantics, idempotent retries, explicit cancel signals, and history-bounding patterns like Continue-As-New in Temporal-style systems.

Decision impact:

- Dynamic Workflows may replace some parent reducer DO responsibilities for batch orchestration.
- They are the right place to test dynamic fanout, parked event waits, quorum/all/race/any reduction, retry envelopes, and cancellation fanout.
- They are not the authority for child receipts, logs, artifacts, or process cancellation.
- Per-run `TerrariumRunCell` remains required.

Security note: internal search surfaced a Dynamic Workflows cross-tenant/control vulnerability ticket. Treat workflow IDs and downstream authority as capability-sensitive; do not make Dynamic Workflows the trust boundary without ID/capability hardening.

Prototype delta:

Add a later `DynamicFacetBatchWorkflow` mock/proof after the run-cell E2E. It should test duplicate terminal events, late events, cancellation intent, quorum/race finalization, and receipt reference integrity.

### E7 — Agents SDK / Think spike

Run: `ter_20260701090550337_0vde1d`

Verdict: **Agents SDK / Think is an integration, subagent, and session layer; it is not the cloud Terrarium execution/control substrate.**

Think/Agents has useful primitives: `agentTool()`, subagents via facets, durable conversation/session state, tool-call persistence, structured subagent failure envelopes, and deploy-churn recovery work. These are valuable for UI/session continuity and model-callable Terrarium runs.

Decision impact:

- Expose Terrarium runs to Think as tools later.
- Do not collapse Terrarium run truth into Think conversation/tool state.
- Think tool results are backend evidence fragments, not `TERRARIUM_RESULT` proof.

Optional later prototype:

```text
Think agentTool("terrarium.run")
  -> starts TerrariumRunCell
  -> returns { runId, status, receiptRef }
  -> parent Think session resumes from Pulse/tool result
```

### E8 — Dynamic Workers / Worker Loader / Facets spike

Run: `ter_20260701090555617_6kgcg7`

Verdict: **Worker Loader / Dynamic Workers are strong mediated JS plugin cells; they do not replace Containers/Sandbox for general execution.**

Best use:

- dynamic JS policy/adapter/plugin/routing/control code;
- authority mediation with injected bindings;
- `globalOutbound: null` or mediated outbound fetch;
- customer/plugin runner adapters that should not see host secrets.

Limits:

- not arbitrary OS process execution;
- no general repo checkout/package install/shell/process supervision;
- not a replacement for Cloudbox/Sandbox/Containers;
- eviction/rehydration and local-vs-prod CPU limit behavior need careful proof.

Decision impact:

Keep "Facets later." Add Worker Loader as an optional dynamic policy/runner-adapter substrate behind the ordinary `TerrariumRunCell`, not as the first execution backend.

Optional later prototype:

```text
TerrariumRunCell
  -> loads DynamicRunnerAdapter via Worker Loader
  -> adapter receives only narrow host capability binding
  -> adapter chooses/mediates execution backend
  -> RunCell remains source of truth
```


### E9 — Storage / event substrate spike

Run: `ter_20260701090604227_kc2n00`

Verdict: **split authoritative state, query indexes, bulk payloads, dispatch, and wakes. Do not overload one substrate.**

Recommended ownership model:

| Concern | Owner | Notes |
| --- | --- | --- |
| Per-run contract/status/cancel/receipt verification/Pulse emit | Durable Object run cell | Authoritative single-run truth. |
| Full logs, log chunks, receipts, backend receipts, artifacts, snapshots | R2 | Bulk payloads by stable refs/digests. |
| Run index, parent/facet membership, artifact/log refs, hashes, bounded tails, terminal facts, reducer state, audit/listing queries | D1 | Queryable metadata only; no huge payloads. |
| Child dispatch, admission, backpressure, async indexing/reduction work | Queues | Small idempotent job refs. |
| Parent orchestration/retry envelope | Dynamic Workflows / Workflows | Optional parent layer, not per-run truth. |
| Artifact/log-ref indexing trigger | R2 Event Notifications | Secondary indexing/wake source, not terminal proof. |
| Hot status/tail/public summary cache | KV | Cache only; never authoritative. |
| Terminal wake/replay/claim/ack | Pulse | Small decide payload; not logs/proof. |

Scale guidance:

- At 1k cells, per-run DO + R2 payloads + D1 indexes + Queues is plausible if logs are chunked and D1 writes are bounded.
- At 10k cells, bottlenecks shift to execution capacity, queue/admission control, R2 write fanout, D1 write/index volume, and Pulse router sharding.
- Do not route every log line through D1 or Pulse. Batch/seal log refs and emit one terminal wake per run.

Prototype deltas:

The local E2E should explicitly model:

1. log chunk writes to an R2-like adapter;
2. D1-like ref/index rows;
3. duplicate Queue delivery;
4. receipt commit before Pulse emit;
5. R2 Event Notification as non-authoritative artifact-index trigger.


### E10 — Cloud platform synthesis

Run: `ter_20260701090613899_ur4kcu`

Verdict: **no primary architecture change; missed-tech spikes refine roles and strengthen the hybrid decision.**

Decision changes from E6-E9:

- Dynamic Workflows move from generic "later Workflows" to a required follow-up before cloud batch orchestration.
- Agents SDK / Think gets an explicit row as integration/tool/session layer, not execution/control substrate.
- Worker Loader / Dynamic Workers stay as optional mediated JS plugin/adapter substrate.
- Storage ownership must be explicit in the first local E2E so logs/artifacts/receipt refs do not accidentally couple to DO memory.

Updated next local E2E:

1. Implement local/Miniflare-shaped `TerrariumRunCell`.
2. Add fake process backend with start, stdout/stderr capture, timeout, explicit cancel, backend receipt fragment.
3. Add receipt verifier requiring exact `runId`, `taskFingerprint`, and `nonce`. Exit 0 alone is `inconclusive` if receipt missing/mismatched.
4. Emit Pulse only after receipt/log refs are committed.
5. Add storage interfaces, even if local-memory/file-backed:
   - `RunStateStore` / DO-like state;
   - `LogArtifactStore` / R2-like chunks/refs;
   - `RunIndexStore` / D1-like query/index rows;
   - `TerminalCallbackTransport` / Pulse-like terminal callback event.
6. E2E tests:
   - successful correlated receipt;
   - exit 0 with missing receipt => inconclusive;
   - mismatched nonce/taskFingerprint => inconclusive/failed;
   - timeout emits `timed_out` with partial logs;
   - explicit cancel emits `cancelled` with partial logs;
   - duplicate terminal collect emits one wake;
   - finish-before-subscribe replay works;
   - cross-owner status/claim fails closed.
7. After that, swap fake backend for Cloudbox or Sandbox and separately spike Dynamic Workflows for parent batch orchestration.

Evidence that would overturn this decision:

- Dynamic Workflows prove they can directly own per-run detached status/read/cancel, receipt refs, idempotent terminal wake, and dynamic fanout without a DO run cell.
- Think proves durable bounded execution, cancellation, partial logs, correlated receipt verification, and replayable terminal wake.
- Worker Loader/Facets prove they can safely own full run lifecycle with less complexity than ordinary DOs.
- A storage/event primitive replaces Pulse/DO for terminal wake plus authoritative per-run truth without weakening receipts.

## Pending evidence

All planned E1-E10 read-only experiments have been integrated.

## Provisional architecture hypothesis

The likely winner is hybrid:

```text
DO / Facet control cell
  owns task contract, status, cancel intent, receipt refs, log refs

Sandbox / Container / Cloudbox execution
  owns actual command/agent process

Pulse
  owns terminal wake notification after receipt commit
```

This preserves Terrarium's proof chain while avoiding making Containers, Workflows, or Pulse pretend to be the whole system.


## Local E2E proof progress

Run: `ter_20260701100818029_wvk02q`

Result: local `TerrariumRunCell` proof exists and passes the first receipt/wake invariants.

Files:

- `src/cloud/local-run-cell.js`
- `test/cloud-terrarium-local-e2e.test.js`

Validation:

```text
node --test test/cloud-terrarium-local-e2e.test.js
7 pass / 0 fail
```

Covered:

- correlated receipt success -> `done` + `verified`;
- exit 0 with missing receipt -> `inconclusive`;
- mismatched nonce -> `inconclusive`;
- duplicate collect emits exactly one wake;
- finish-before-subscribe wake replay;
- cross-owner status fails closed;
- malformed/extra-key receipt classification.

Open local E2E gap: timeout and explicit cancel terminal paths still need assertions before the P0 proof is complete.


## Local E2E proof complete

Run: `ter_20260701101032018_sdy8h9`

Result: the local `TerrariumRunCell` proof now covers receipt truth, wake idempotency/replay, owner scoping, timeout, and explicit cancel.

Validation in parent repo:

```text
node --test test/cloud-terrarium-local-e2e.test.js
12 pass / 0 fail
```

Additional coverage added:

- timeout -> `failed` / `deadline-reached`, partial logs retained, no success receipt accepted, exactly one wake;
- cancel -> `cancelled` / `cancel-requested`, partial logs retained, exactly one wake;
- duplicate collect after cancel emits one wake;
- cancel intent wins over a raced verified receipt;
- timeout intent wins over a raced verified receipt.

Decision impact: the core local run-cell architecture is viable. Remaining architecture-discovery work is choosing the first real execution backend and sequencing Dynamic Workflows / Worker Loader follow-ups.


## First real backend decision

Run: `ter_20260701101423723_2odr8e`

Decision: **test Sandbox/Containers first; Cloudbox second.**

Reason:

- The local `TerrariumRunCell` backend contract (`spawn -> stdout/waitExit/cancel/timeout`) maps most directly to raw Sandbox/Container process execution.
- The top remaining uncertainty is real process control: SIGTERM/SIGKILL, timeout, partial stdout/stderr, and terminal receipt semantics. That uncertainty lives at the Sandbox/Container layer.
- Cloudbox is built on the Sandbox substrate and adds product-shaped artifacts, diffs, proof pages, D1/R2 records, and live workspace APIs. Those are valuable backend #2 features, but they should not hide the raw process-cancel proof.

First real backend prototype:

1. Add a `SandboxBackend` behind the existing `TerrariumRunCell` backend interface.
2. Start one bounded command with cwd/env/timeout.
3. Capture stdout/stderr chunks into `LogArtifactStore`.
4. Implement explicit cancel with real process/backend cancellation.
5. Reuse the same receipt verifier.
6. Emit wake only after receipt/log refs commit.
7. Port the 12 local E2E assertions to the real backend.

Success gates:

- correlated receipt -> `done`/`verified`;
- exit 0 missing/mismatched receipt -> `inconclusive`;
- timeout -> `failed`/`deadline-reached`, partial logs retained, exactly one wake;
- explicit cancel -> `cancelled`/`cancel-requested`, partial logs retained, exactly one wake;
- cancel/timeout intent wins over raced verified receipt;
- duplicate collect emits one wake;
- finish-before-subscribe replay works;
- owner-scoped status fails closed;
- bounded in-progress log read exists.

Cloudbox waits until Sandbox/Container process control is proven. It becomes backend #2 for artifact/diff/proof-page integration.

Evidence that would reverse this:

- raw Sandbox/Containers cannot cancel child processes or preserve partial logs, while Cloudbox live delete/stop can produce acceptable terminal cancel receipts;
- first product target needs Cloudbox's repo checkout/artifacts/diffs/proof pages more than process-control fidelity;
- Cloudbox exposes a smaller detached start/status/cancel API with Terrarium-verifiable receipts.


## Worker Loader / Facets sequencing decision

Run: `ter_20260701101646676_6zi45l`

Decision: **after the first real execution backend adapter.**

Worker Loader / Facets are a mediation layer behind `TerrariumRunCell`; they depend on a real backend to mediate. Proving them against the fake backend would test the least load-bearing half.

Preconditions before Worker Loader / Facets proof:

- first real backend adapter passes the local 12-invariant suite with a real process;
- named `ExecutionBackend` contract exists;
- concrete mediation requirement exists: untrusted plugin, per-run policy adapter, or mediated outbound.

Success gates for later proof:

- loaded adapter receives only narrow injected capability binding;
- no host env/secrets/backend credentials visible to plugin code;
- unmediated egress blocked (`globalOutbound: null` or equivalent);
- adapter mediates real backend while RunCell remains source of truth;
- eviction/rehydration does not duplicate wakes or lose truth;
- CPU/time limits and ID/capability hardening characterized.

Evidence that would reverse sequencing:

- Worker Loader/Facets can safely own full lifecycle with less complexity than ordinary DOs;
- primary product target becomes untrusted plugin JS, not OS/repo execution;
- real-backend selection stalls while mediated-plugin proof is ready;
- mediation security boundary can be fully proven against fake backend and is urgent.


## Dynamic Workflows sequencing decision

Run: `ter_20260701101646676_vosuzq`

Decision: **after the first real execution backend adapter.**

Dynamic Workflows are a parent reducer over child terminal facts. They need realistic child facts from a real backend before their fanout/reduce/cancel semantics are meaningful. Front-loading Dynamic Workflows would re-prove parent orchestration over fake facts while leaving the per-run risk untouched.

Success gates before Dynamic Workflows proof:

- first real backend passes the local receipt/wake invariants with real process behavior;
- explicit cancel and timeout produce partial logs and terminal states;
- exactly one Pulse wake after real receipt/log commit;
- storage refs exercised;
- cross-owner status fails closed.

Then test `DynamicFacetBatchWorkflow` with 5-10 real backend facets: stable `facetJobId`, duplicate terminal events, late events, crash-before-emit recovery, quorum/race/any/all, idempotent cancellation fanout, and capability-hardened workflow IDs.

## Red-team review of local proof

Run: `ter_20260701101646676_fzr492`

Verdict: **red-team not clean. Local proof validates receipt truth, but it is not yet a load-bearing detached-backend proof.**

P0/P1 objections:

1. **P0 — backend boundary is still held-handle/in-process.** Current backend returns a live handle with `stdout()`, `waitExit()`, `cancel()`, `timeout()`. Real backends return durable `executionRef` and require polling/fetching logs later.
2. **P0 — no reconcile path.** Wake idempotency is proven only intra-process. Crash between terminal state commit and wake emit can lose the wake.
3. **P0 — cancel/timeout intent is not durable.** Intent lives on the handle; restart between `cancel()` and `collect()` could lose intent and accept a raced receipt.
4. **P1 — storage split is by name only.** Receipt is validated from in-memory stdout, not persisted/chunked log refs.
5. **P1 — unbounded live handles bake in 10k-cell risk.** The abstraction pins one handle per run until terminal.

Required next proof:

Refactor local proof to detached-backend shape before Sandbox/Containers:

```text
backend.start(contract) -> executionRef
backend.poll(executionRef) -> state/exit/log refs
backend.cancel(executionRef) -> durable cancel intent/result
RunCell persists executionRef, cancelRequested/deadlineReached, log refs
RunCell can reconcile terminal state and wake after restart
```

New E2E must prove:

- collect finalizes from `executionRef` after live handle is gone;
- cancel/deadline intent survives lost handle/restart;
- crash after terminal commit but before wake emit is repaired by reconcile and emits one wake;
- receipt validation reads persisted log chunks/ref, not in-memory stdout;
- backend handle count is not O(active runs).


## Detached local E2E proof complete

Run: `ter_20260701101931370_by1g4e`

Result: red-team P0s against the local proof were addressed. The local proof now uses a detached `executionRef` backend shape instead of a held live handle.

Validation in parent repo:

```text
node --test test/cloud-terrarium-local-e2e.test.js
17 pass / 0 fail
```

New proof coverage:

- backend `start()` returns an opaque `executionRef`;
- RunCell persists `executionRef` and terminal intent;
- collect can finalize after live handle loss;
- cancel intent survives handle loss;
- deadline intent survives handle loss;
- reconcile repairs crash after terminal commit before wake emit and emits exactly one wake;
- receipt validates across multiple persisted log chunks, not live stdout.

Decision impact: local architecture-discovery P0/P1s are closed. The next step is implementation of the first real backend adapter: Sandbox/Containers first, then Cloudbox, then Dynamic Workflows batch orchestration, then Worker Loader/Facets only for mediated plugin/authority needs.
