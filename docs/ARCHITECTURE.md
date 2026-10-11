# How Terrarium works

Terrarium is a small Worker that hands each job to the Cloudflare product built for it. The service is about 900 lines of Effect 4 TypeScript in [`effect/src`](../effect/src). The same picture, drawn, is on the site at `/how-it-works`.

```
 Your agent (Pi)                Cloudflare, behind Access
 ┌──────────────┐  1 start   ┌──────────┐   2 reserve   ┌────────────────┐
 │ MCP client + │──────────► │  Worker  │─────────────► │ Durable Object │
 │ callback ext │            │ site·API │               │ one per person │
 └──────▲───────┘            └────┬─────┘               └────────────────┘
        │                         │ 3 start Workflow
        │                    ┌────▼─────┐   loops   ┌────┐
        │  7 result          │ Workflow │ ────────► │ KV │
        │                    │ per run  │           └────┘
        │                    └────┬─────┘
        │                         │ 4 run task + one-time code
        │                    ┌────▼──────┐  5 model call  ┌────────────┐
        └─────────────────── │ Container │ ─────────────► │ Workers AI │
                             │no internet│  via Worker    └────────────┘
                             └───────────┘
```

## The parts

| Part | Job | Code |
|---|---|---|
| Cloudflare Access | Signs you in. The Worker checks the signed token on every request; your email owns everything you start. | `identity.ts` |
| Worker | Serves the site and API, checks who you are, starts Workflows. Holds no state. | `worker.ts`, `app.ts` |
| Durable Object, one per person | The state that must be exact: idempotency keys, live-run count, rate limit, run list, completion events. SQLite. | `owner-do.ts`, `owner-store.ts` |
| Run Workflow | One instance per run. Starts the container, checks the receipt, records the result once. | `run-workflow.ts`, `receipt.ts` |
| Loop Workflow | One instance per loop. Starts runs until one passes the gate or attempts run out. The next step is a pure function of past attempts. | `loop-workflow.ts`, `loop-decide.ts` |
| Container | Runs Pi with the task and a one-time code. No internet; its only route is the model, through the Worker. | `sandbox.ts`, `pi-child.ts`, `Dockerfile.pi` |
| Workers AI | The model. The Worker calls it through its binding, so the container never holds a key. | `sandbox.ts` |
| KV | The loop index for the `/loops` page. | `loops-api.ts` |

## One run, start to finish

1. Your agent calls `POST /api/runs` with an idempotency key, signed in through Access.
2. The Worker reserves a slot in your Durable Object: the same key returns the same run, at most 8 runs live, 30 per minute.
3. The Worker starts a Run Workflow. The run ID, task fingerprint and one-time code are fixed now, by the server.
4. The Workflow starts a container with the task and the code.
5. Pi in the container asks the model. The request leaves through the Worker, which calls Workers AI.
6. Pi prints its answer and one `TERRARIUM_RESULT=` line. The Workflow checks it: exactly one line, the right code, this run, this task. Only then is the run `verified`.
7. The result is recorded once in the Durable Object. The Pi extension sees the run finish and puts the result into your session.

A one-word task takes about 20 seconds end to end. Starting a fresh container takes 4 to 5 seconds of that, and starting Pi inside it takes 2 to 18.

## What "verified" proves

It proves the right run answered: the receipt carries the server's one-time code for this run and this task. It does not prove the answer is true. Pi runs with tools off today, so an agent asked to run a command can only describe made-up output, and that run is still verified. Anything that needs the truth should be checked by a command Terrarium runs itself, not by the agent's words.

## Loops

A loop is a contract: a goal, a task, the text the answer must contain, and at most 5 attempts. The Loop Workflow runs attempts as ordinary runs. After each one, `decideNext` looks only at the contract and the attempts so far, and says continue or stop. Replaying the same attempts always gives the same decision. The `/loops` page reads what the Workflow recorded and adds nothing of its own.

## Why it's built this way

- **Each job goes to a Cloudflare product.** Workflows keep steps, retries and history. Durable Objects keep exact counters. Access does sign-in. Less of our own code to trust.
- **Errors are values.** Effect 4 types every failure; `oxlint` with anti-slop rules runs at error level. Async code exists only at the Workers boundary.
- **Tests and mutation testing.** 68 tests run in about a second, and `effect/scripts/mutate.mjs` checks that they catch deliberate bugs.
- **The gate.** `npm run gate:effect` runs tests, types, lint, mutation score, the prod-check receipt and the size benchmark.
