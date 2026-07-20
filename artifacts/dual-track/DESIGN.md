# Dual-track design (grounded inline, tick 1) — loop 03e298ae

Children refused (cloud-default MCP has no TERRARIUM_ALLOW_LOCAL=1); design done inline from real file reads.

## Track 2 — /api/batches (backend, C1 slice)

### Existing surface (verified by read)
- `api-runs.js` POST path: requires `idempotency-key` header (regex), auth via `authenticatePrincipal(request,env)` → `ownerId` (never from client), server-computes `canonicalRequestHash({task,spec})`, reserves budget via `TERRARIUM_PRINCIPAL_BUDGET` DO (`/reserve` returns canonical runId), then proxies `admit` to `TERRARIUM_RUN` DO (one DO per runId via `idFromName(runId)`), expects 202, rolls back budget on non-202.
- `admission.js`: `evaluateAdmission` + `AdmissionController.admit()` — `DEFAULT_ADMISSION_POLICY.maxConcurrentPerOwner = 8`. This is the per-owner concurrency budget already enforced at the DO cell.
- `run-index.js`: `indexRunAdmitted`/`indexRunTerminal` KV projection keyed `runidx:<owner>:<runId>`; `listPrincipalRuns` returns `{runs, channels}`.
- Route reg (`control-worker.js` ~line 193): `if (url.pathname.startsWith("/api/runs") || url.pathname === "/api/models") { const routed = await handleApiRuns(...); if (routed) return routed; }`

### Plan for src/cloud/api-batches.js (NEW)
Reuse the SAME single-run admit path — NO forked cell logic. A batch is N ordinary `/api/runs` admits under a bounded window.
- `POST /api/batches`: auth → parse `{tasks:[...], maxConcurrency?}` (cap N, cap maxConcurrency ≤ policy.maxConcurrentPerOwner=8). Mint `batchId`. For each task, call the identical reserve+admit sequence factored out of `handleApiRuns` POST into a shared `admitOneRun(env, ownerId, {task, spec}, idempotencyKey)` helper (refactor, not fork). Admit only up to `maxConcurrency` live at once; as each admits, record child runId. Write a batch record to KV `batchidx:<owner>:<batchId>` = {batchId, ownerId, childRunIds[], maxConcurrency, createdAt, status:"running"}.
- `GET /api/batches/:id`: auth → read batch record → for each childRunId, read its run-index record (status only, NOT re-executing). Aggregate: `{batchId, total, running, done, failed, children:[{runId, status, ...}]}`. **Failure-truth gate: never report batch "done" unless ALL children terminal AND all ok; any inconclusive/failed/cancelled keeps batch status "failed" or "running", never "done".** Batch record only REFERENCES child runIds — child receipts stay authoritative in their own DOs.

### Minimal edits
- `api-runs.js`: extract `admitOneRun()` helper from the POST body; POST /api/runs calls it (behavior unchanged).
- `run-index.js`: add `putBatchRecord`/`getBatchRecord`/`listBatchChildren` (KV `batchidx:` prefix). No change to run records.
- `control-worker.js`: ONE route line before/after the /api/runs block: `if (url.pathname.startsWith("/api/batches")) { const r = await handleApiBatches(request, env); if (r) return r; }`
- `admission.js`: NO change — per-owner concurrency cap already enforced per cell; batch window just throttles admit rate client-side of the DO.

### Proof-gate tests (test/cloud-api-batches.test.js)
1. peak-live ≤ maxConcurrency: admit N=10 with maxConcurrency=3, assert never >3 concurrent admits in flight.
2. failure-truth: batch with 1 failed child → GET never returns status "done"; returns "failed" with the failed child referenced.
3. no false rollup: mixed done/running → status "running", not "done".
4. receipt-reference: batch record contains child runIds only, no inlined receipt fields (child receipt stays in its DO).
5. auth: GET /api/batches/:id without token → 401; cross-owner batchId → 404 (normalizeNotFound pattern).

## Track 1 — run-index page (frontend)

### Existing surface (verified)
- `App.svelte` is one file, `$state` route via `path`/`hash`/`selectedDoc`; `route()` returns home|docs|changelog. Nav adds routes by `navigate('/x')` + a `{:else if route()==='x'}` block. Styling: `.docs-shell`, `.log-shell`, `data-reveal` scroll animation.
- `GET /api/runs` response shape (from api-runs.js + run-index.js): `{ ok:true, runs:[{runId, ownerId, status, channel, workflowId, taskFingerprint, grounding, createdAt, terminalAt, ok}], channels:{<channel>:{channel,total,running,done,failed,other}} }`. Auth: an Authorization header (Bearer scheme) carrying the control token → 401 if missing/wrong. Query params: `channel`, `status`, `since` (ms epoch digits), `limit`.

### Plan
- New route `/runs` (or `#runs`): add to `route()` and a `{:else if route()==='runs'}` block + a topbar nav link.
- Token held in a `$state` var (sessionStorage, never persisted to disk/repo). Input to paste control token.
- `fetch('/api/runs?...', {headers:{Authorization: bearerScheme + token}})`; on 401 show auth prompt, never a broken page.
- Render `channels` rollup as group headers; under each, the `runs` filtered to that channel: runId (mono), status pill, createdAt/terminalAt, grounding badge.
- Status + since filter controls re-issue the fetch.
- Small inline client function `fetchRuns(token, {channel,status,since})`.

### Proof
- Live: `curl with an auth header (Bearer scheme + token) against https://terrarium.coey.dev/api/runs` returns shape above; page renders it. Without token → auth prompt (page 200, API 401).
