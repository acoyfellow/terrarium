# Loops slice notes

- `loops-api.ts` defines its own minimal `LoopsEnv` (`LOOPS_KV`, `LOOP_WORKFLOW`); wrangler config must bind these names.
- `loop-workflow.ts` exports `makeLoopWorkflow(runsLayer)`; the worker entry must export the class built with the real Runs layer.
- Loop ids use `crypto.randomUUID()` instead of the shared `Ids` service to keep handler requirements to `Owner` only; consider adding `Ids` to the handler requirements later.
- The workflow provides `Owner` with `method: "bearer"` for the loop owner; shared may want a `"workflow"` method.
