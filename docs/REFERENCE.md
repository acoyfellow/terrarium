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
| `POST /api/runs` | Start a run. Body `{ task, proof?, channel? }`. `proof` is a shell command run in `/workspace` in the box after the agent finishes, header `idempotency-key`. Returns `{ runId, contract }`. The same key returns the same run. |
| `GET /api/runs` | List your runs, newest first. Query `channel`, `status`, `limit`. |
| `GET /api/runs/:id/status` | `{ status, terminal }`. `terminal` is null while the run is going. |
| `GET /api/runs/:id/logs` | The run's full output. |
| `POST /api/runs/:id/cancel` | Cancel a run that hasn't finished. |
| `POST /api/loops` | Start a loop. Body `{ goal, task, expect?, proof?, maxAttempts? }`; give `expect`, `proof` or both. An attempt passes when the proof exits 0 (if given) and the answer contains `expect` (if given). `maxAttempts` is 1 to 5, default 3. |
| `GET /api/loops` | Your loops, with what each Workflow recorded. |
| `POST /api/sessions/:name/turn` | Send one turn to your durable Pi session `:name`. Body `{ text }`. The conversation is stored in a Durable Object; tools run in the session's box. |
| `POST /api/sessions/:name/replace-box` | Destroy the session's box and give it a new one. The conversation stays. |
| `GET /api/whoami` | `{ owner, method }`. |
| `POST /claim`, `POST /ack` | Completion events: `{ subscriberId, limit? }` and `{ subscriberId, eventId }`. |
| `GET /health` | `{ ok: true }`. No sign-in. |

## Run statuses

| Field | Values |
|---|---|
| `status` | `running`, `done`, `failed`, `cancelled` |
| `terminal.provenance` | `this-run`, `missing`, `mismatch`, `malformed` |
| `terminal.proof` | `{ command, exitCode, output }`, or null when no proof was given |

A run is `done` only when its provenance is `this-run` (exactly one `TERRARIUM_RESULT=` line, carrying this run's ID, task fingerprint and one-time code) and, if it has a proof, the proof exits 0.

## The box

Pi in the box has the `read`, `write`, `edit` and `bash` tools. A run can add up to 4 Pi extensions with `plugins: [{ name, source, tools? }]` on `POST /api/runs`. Each `source` is at most 20,000 characters and is loaded only in that run's box. List the tools an extension adds in `tools` so the model may call them. Extensions get the same sealed box: no internet and no credentials. The box has no internet: outside sites get 403. Files the agent writes are deleted when the run ends.

## MCP tools

| Tool | Arguments |
|---|---|
| `terrarium_spawn` | `task`, optional `proof`, `channel`, `background` |
| `terrarium_status` | `runId` |
| `terrarium_read` | `runId` |
| `terrarium_cancel` | `runId` |
| `terrarium_list` | optional `channel`, `limit` |
| `terrarium_loop_start` | `goal`, `task`, `expect` and/or `proof`, optional `maxAttempts` |
| `terrarium_loop_status` | optional `loopId` |

## pi-subagents

The Terrarium Pi extension registers a `terrarium` provider for pi-subagents `external-job` agents. Copy `examples/pi-subagents/boxed.md` to `.pi/agents/` and load both extensions. A `subagent` call to that agent starts a Terrarium run. `runner.options.proof` and `runner.options.channel` go to the run; pi-subagents gets the run's state and its summary and logs as the result.

## terrarium_batch

The Pi extension adds a `terrarium_batch` tool: `{ tasks, proof?, channel?, mode? }`, up to 8 tasks started in parallel. `mode: "all"` waits for every run. `mode: "first"` returns as soon as one run passes and cancels the others. Codemode scripts call it as `tools.terrarium_batch` when the tool is enabled.

## Metric loops

`POST /api/loops` with `metric: { command, direction: "lower"|"higher", seed?, baselineRuns?, minGain?, target? }` and no `expect`, `proof`, `checks` or `wake`.

1. A seed run (the `seed` task, or no change) and `baselineRuns` (2 to 5, default 3) idle runs measure `command`. The median is the baseline; the spread (max minus min) is the noise.
2. Each attempt starts from the best workspace so far. A new value is kept only if it beats the best by more than the noise and `minGain`.
3. The loop stops at `target` or after `maxAttempts`. `output.metric` has the baseline, every step, and the best run.

## Limits

| Limit | Value |
|---|---|
| Live runs per person | 8 |
| New runs per person per minute | 30 |
| Foreground wait in `terrarium_spawn` | 10 minutes |
| Loop attempts | 1 to 5 |
| Completion event lease | 60 seconds |

## Deploy your own

You need a hostname on Cloudflare, and a Cloudflare Access app for it with its AUD.

1. From the repo root: `npm run deploy:own -- --name <name> --host <host> --team <team> --aud <aud>`.
2. For machine tokens, from `effect/`: `npx wrangler secret put TERRARIUM_PRINCIPALS -c wrangler.<name>.local.jsonc`.
3. Check it: `TERRARIUM_LOGIN_APP=<url> node scripts/prod-checks.mjs <url>`.

The checked-in `wrangler.jsonc` has no hostname and no Access settings, so it can't replace a working deploy by mistake. See [Rollback](./ROLLBACK.md) to go back to the old service.

## Checks

| Command | What it runs |
|---|---|
| `npm test` in `effect/` | 87 tests, about a second |
| `npm run lint` in `effect/` | oxlint with anti-slop rules at error level |
| `node scripts/mutate.mjs` in `effect/` | Mutation testing |
| `node scripts/pi-callback-proof.mjs` in `effect/` | A real Pi session gets a background result |
| `npm run check:proof-run` at the repo root | A live run whose false claim fails its proof |
| `npm run check:egress` at the repo root | Outside sites get 403 from inside the box |
| `npm run gate:effect` at the repo root | All of the above plus the prod-check receipt |
