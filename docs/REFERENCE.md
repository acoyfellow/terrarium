# Terrarium reference

The exact surface of the Effect 4 service in [`effect/`](../effect). For the design, read [How it works](./ARCHITECTURE.md).

## Sign-in

Every route except `/health` needs one of these, checked in this order:

| Header | Who uses it |
|---|---|
| `cf-access-token` | A person, with a token from `cloudflared access token -app=<url>`. The owner is your email. |
| `authorization: Bearer <token>` | A machine, with a token listed in the `TERRARIUM_PRINCIPALS` secret. |
| `cf-access-jwt-assertion` | Added by Access at the edge. Used when neither of the above is present. |

## API

| Route | What it does |
|---|---|
| `POST /api/runs` | Start a run. Body `{ task, channel? }`, header `idempotency-key`. Returns `{ runId, contract }`. The same key returns the same run. |
| `GET /api/runs` | List your runs, newest first. Query `channel`, `status`, `limit`. |
| `GET /api/runs/:id/status` | `{ status, terminal }`. `terminal` is null while the run is going. |
| `GET /api/runs/:id/logs` | The run's full output. |
| `POST /api/runs/:id/cancel` | Cancel a run that hasn't finished. |
| `POST /api/loops` | Start a loop. Body `{ goal, task, expect, maxAttempts? }`; `maxAttempts` is 1 to 5, default 3. |
| `GET /api/loops` | Your loops, with what each Workflow recorded. |
| `GET /api/whoami` | `{ owner, method }`. |
| `POST /claim`, `POST /ack` | Completion events: `{ subscriberId, limit? }` and `{ subscriberId, eventId }`. |
| `GET /health` | `{ ok: true }`. No sign-in. |

## Run statuses

| Field | Values |
|---|---|
| `status` | `running`, `done`, `failed`, `cancelled` |
| `terminal.contractStatus` | `verified`, `missing`, `mismatch`, `malformed` |

A run is `done` only when its receipt is `verified`: exactly one `TERRARIUM_RESULT=` line, carrying this run's ID, task fingerprint and one-time code.

## Limits

| Limit | Value |
|---|---|
| Live runs per person | 8 |
| New runs per person per minute | 30 |
| Foreground wait in `terrarium_spawn` | 10 minutes |
| Loop attempts | 1 to 5 |
| Completion event lease | 60 seconds |

## Deploy your own

From `effect/`:

1. Copy `wrangler.jsonc` to a gitignored `wrangler.<name>.local.jsonc`. Set the KV namespace ID, your hostname under `routes`, and the vars `TERRARIUM_ACCESS_TEAM_DOMAIN`, `TERRARIUM_ACCESS_AUD` and `TERRARIUM_MODEL_HOST`.
2. Put the Worker behind a Cloudflare Access app.
3. `npx wrangler secret put TERRARIUM_PRINCIPALS -c wrangler.<name>.local.jsonc` for machine tokens.
4. `npx wrangler deploy -c wrangler.<name>.local.jsonc`.
5. Check it: `TERRARIUM_LOGIN_APP=<url> node scripts/prod-checks.mjs <url>`.

The checked-in `wrangler.jsonc` has no hostname and no Access settings, so it can't replace a working deploy by mistake. See [Rollback](./ROLLBACK.md) to go back to the old service.

## Checks

| Command | What it runs |
|---|---|
| `npm test` in `effect/` | 68 tests, about a second |
| `npm run lint` in `effect/` | oxlint with anti-slop rules at error level |
| `node scripts/mutate.mjs` in `effect/` | Mutation testing |
| `node scripts/pi-callback-proof.mjs` in `effect/` | A real Pi session gets a background result |
| `npm run gate:effect` at the repo root | All of the above plus the prod-check receipt |
