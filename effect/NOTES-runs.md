# Runs + Callbacks slice notes

- Run = one Workflow instance (`RunWorkflow`, id = runId). Steps: `run sandbox` (Sandbox service, receipt verified purely by `verifyReceipt`), `record terminal` (owner DO `finish`, which also inserts the single callback event with `insert or ignore`, so retries stay exactly-once).
- Owner DO (`OwnerDO`, one per owner via `getByName(ownerId)`) holds only: idempotency map (key -> request hash + runId), live/minute admission counts, run index for list, callback mailbox. Store logic is pure-over-`Sql` in `owner-store.ts` so tests run it on `node:sqlite`.
- DO RPC returns `Reply<A>` (encoded tagged errors), decoded back with `fromReply`.
- Cancel writes the terminal first (so it wins) then terminates the Workflow instance; the Workflow's later `finish` is a no-op.

## Later / needed elsewhere

- Sandbox wiring: `SandboxNotWired` stub in `run-workflow.ts` fails with Upstream "not wired"; replace with a Container-backed Layer (B2.3: task + contract only, model route via Worker).
- Wrangler bindings needed: `OWNER` (DO class `OwnerDO`, sqlite migration), `RUN_WORKFLOW` (workflow class `RunWorkflow`), plus a `worker.ts` that maps `Owner` and calls `handleRuns` from `runs-api.ts` with `RunsLive`, `CallbacksLive`, `cloudflareLayer(env)`, `Clock`, `Ids` provided.
- shared.ts: `Runs.list` has no status filter; status is filtered in the API after the limit. Consider `list(channel, status, limit)`. A shared `Callbacks` service / `CallbackEvent` schema could move into shared.ts for the Pi/MCP slice (currently in `runs.ts` / `owner-store.ts`).
- Timeout status is not produced yet; a Workflow step timeout should map to `timeout`.
