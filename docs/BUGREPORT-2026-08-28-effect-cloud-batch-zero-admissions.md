# Bug report — Effect cloud batch reports three failures without admitting any runs

## Summary

`terrarium_spawn_batch` fails for three independent text-only cloud jobs before admitting any run. It returns `reason: "all-complete"`, zero successes, three failures, and empty admission and run lists.

The same three jobs succeed when submitted concurrently through three individual `terrarium_spawn` calls. This isolates the failure to the Effect cloud batch path rather than cloud execution or the task payloads.

## Environment

- Terrarium version: `0.0.1`
- Repository commit: `47b8b3097f12d99ff29678dd05144e4935e7c4bb`
- Cloud URL: `https://terrarium.coey.dev`
- Cloud and Pulse configuration: enabled
- Batch strategy: `all`
- Batch concurrency: `3`
- Batch timeout: `120000` ms

## Reproduction

Call `terrarium_spawn_batch` with:

```json
{
  "jobs": [
    { "task": "Return exactly: SHARD A OK" },
    { "task": "Return exactly: SHARD B OK" },
    { "task": "Return exactly: SHARD C OK" }
  ],
  "strategy": "all",
  "concurrency": 3,
  "label": "cloud-swarm-smoke",
  "timeoutMs": 120000,
  "verbose": true
}
```

## Actual result

```json
{
  "ok": false,
  "cloud": true,
  "effectCloud": true,
  "strategy": "all",
  "reason": "all-complete",
  "timedOut": false,
  "successCount": 0,
  "failureCount": 3,
  "runIds": [],
  "group": {
    "complete": true,
    "ok": false,
    "runs": []
  },
  "admissions": [],
  "cancellations": []
}
```

No cloud run IDs are returned. The result contains no per-job error explaining why each job failed.

## Expected result

The client should admit three cloud runs, wait for their terminal receipts, and return:

- three run IDs;
- three admissions;
- `successCount: 3`;
- `failureCount: 0`;
- `ok: true`.

If admission fails, the result should retain one explicit admission error per job instead of reducing the batch to `all-complete` with empty run and admission lists.

## Control experiment

The same tasks were submitted at the same time through three individual background `terrarium_spawn` calls.

| Shard | Run ID | Authoritative result | Duration |
|---|---|---|---:|
| A | `ter_mtddupgv_01052bf65d31` | `done`, `ok: true`, verified, `SHARD A OK` | 17.0 s |
| B | `ter_mtddupgv_2f879c353502` | `done`, `ok: true`, verified, `SHARD B OK` | 6.8 s |
| C | `ter_mtddupgv_17384b9f1d0e` | `done`, `ok: true`, verified, `SHARD C OK` | 11.0 s |

The three runs were admitted within 129 ms of each other. The cloud channel summary reported three done, zero failed.

## Impact

The batch API cannot currently be used for cloud eval fan-out. Callers must issue independent cloud spawns and implement their own join and terminal reconciliation. The returned result also looks like three task failures even though no tasks were admitted.

## Root cause (fixed in tree)

Per-job Effect batch keys were `${uuid}:${index}`. `POST /api/runs` only accepts
`^[A-Za-z0-9._~+/=-]{8,255}$`, so `:` is illegal. Every job returned 400
`idempotency-key required` before admit. Native `/api/batches` already used `.`.
Unit tests mocked HTTP and never applied the regex, so they stayed green.

## Likely fault boundary

The failure is in the Effect cloud batch path before or while building `execution.admissions`:

- `src/effect-cloud-client.js` — `effectCloudSpawnBatch()`
- Effect batch execution used by `executeCloudBatch()`
- conversion through `batchResult()`

`batchResult()` receives an execution with no admissions and a settled `all-complete` result that counts all three jobs as failures. Preserve the underlying per-job Effect failures to identify the root cause.

## Related callback observation

All three successful individual control runs emitted `Failed/orphaned` callback events even though authoritative terminal status and receipts were successful. That is a separate callback reconciliation defect and should not be used to explain the zero-admission batch failure.

An older report, `docs/BUGREPORT-2026-07-21-batch-opaque-error-and-cloud-callbacks-silent.md`, covered stripped preflight diagnostics and missing callbacks. This reproduction is different: the jobs are text-only, the batch passes preflight, and the Effect batch result reports `all-complete` without admissions.

## Acceptance criteria

1. The reproduction admits and completes all three cloud jobs.
2. The batch returns three unique run IDs and three verified terminal outcomes.
3. A forced per-job admission failure is surfaced with its original error and job index.
4. An empty admission list cannot settle as `all-complete` for a non-empty batch without an explicit internal error.
5. Unit and integration tests cover three concurrent text-only jobs through the Effect cloud batch path.
