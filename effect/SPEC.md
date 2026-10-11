# Terrarium (Effect 4) behaviour list

This is the whole product. Every kept test maps to a line here. Anything not listed is not built.

Rules for the build:

- Less code wins. Use a Cloudflare primitive before writing our own: Workflows for anything with steps, waits, retries or history; Durable Objects only for state that must be strongly consistent; Access for identity; KV/R2 only for blobs and indexes.
- Effect 4 throughout: typed errors (`Schema.TaggedErrorClass`), `Schema` at every boundary, services as `Context.Service` with `Layer`s, no `async`/`await` or `try`/`catch` in business logic.
- anti-slop lint is clean with every rule at error. No type assertions.
- Terraloops are sacred: `/api/loops` and the `/loops` page keep working with the same contract shape.

## B1 Identity

- B1.1 A request carries a Cloudflare Access user JWT (`cf-access-jwt-assertion` or `cf-access-token`). It is verified RS256 against the team certs, `aud` and `iss`. The owner is `user:<local>:<domain>` from the email.
- B1.2 A machine may instead present a bearer token listed in `TERRARIUM_PRINCIPALS` (JSON array of `{id, token}`); the owner is that `id`. Comparison is constant-time.
- B1.3 Anything else is 401. No endpoint except `/health` answers without an owner.
- B1.4 `GET /api/whoami` returns `{ ok, method, owner, email? }`.

## B2 Runs

- B2.1 `POST /api/runs {task, spec?}` with an `idempotency-key` header (8..255 chars of `[A-Za-z0-9._~+/=-]`) admits one run and returns 202 `{runId, contract:{runId, taskFingerprint, nonce}}`. Same key and same body returns the same runId. Same key with a different body is 409.
- B2.2 A run is one Workflow instance. Its steps: admit, start container, wait for the result, verify the receipt, record terminal. Retries and history come from the Workflow, not our code.
- B2.3 The container gets only the task text and the contract. It has no internet except the model route; the model credential is added by the Worker, never given to the container.
- B2.4 The runner's output contains at most one `TERRARIUM_RESULT={...}` line. The run is `verified` only if exactly one such line parses, its nonce matches, and the Worker fills runId and taskFingerprint itself. Otherwise `missing`, `mismatch` or `malformed`. Model prose never makes a run verified.
- B2.5 Terminal status is one of `done | failed | cancelled | timeout`. Once terminal, it never changes.
- B2.6 `GET /api/runs/:id/status`, `GET /api/runs/:id/logs`, `POST /api/runs/:id/cancel`. Another owner's run is 404, never 403. Cancel of a terminal run is a 200 no-op, not a 500.
- B2.7 `GET /api/runs?channel&status&limit` lists only the caller's runs, newest first.
- B2.8 Per-owner limits: at most N live runs (default 8) and M admissions per minute. Over the limit is 429 with a reason.

## B3 Callbacks

- B3.1 When a run becomes terminal, exactly one terminal event is recorded for its owner.
- B3.2 `POST /claim {subscriberId, limit}` returns unacked events for that owner; `POST /ack {subscriberId, eventId}` acks one. A claimed but unacked event is returned again after a lease expires. A malformed ack does not count as delivery.
- B3.3 One owner can never claim or ack another owner's events.

## B4 Loops (sacred)

- B4.1 `POST /api/loops {goal, task, expect, maxAttempts}` validates the contract (all required, maxAttempts 1..5) and starts one Workflow. Returns 202 `{loopId, contract}`.
- B4.2 The loop Workflow decides with pure code only: stop `passed` when an attempt is done, verified and its answer (harness lines removed) contains `expect`; stop `exhausted` after maxAttempts; otherwise spawn the next attempt as a run.
- B4.3 Replaying the same recorded attempts produces the same decisions.
- B4.4 `GET /api/loops` and `GET /api/loops/:id` return only the caller's loops, with the Workflow's own recorded status and output.
- B4.5 The `/loops` page renders that read-only view.

## B5 Client and Pi

- B5.1 `terra login <url>` signs in with `cloudflared access login`, writes the Pi MCP entry and links the Pi extension folder.
- B5.2 The MCP server exposes spawn, status, read, cancel, list and batch, backed by the HTTP API.
- B5.3 The Pi extension claims terminal callbacks for the session and injects one follow-up per event.

## Out of scope (deleted, not ported)

Campaign lab, hostile scenarios, drift lab, strategist, public ledger and traces, Go migration docs, local-process runner, worktree capture, cloudbox bridge, trust calibration and grading, WASM verifier, model ladder, healing CLI, failure reports. They can come back only as a new behaviour line here.
