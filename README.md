# Terrarium

[![Live demo](https://img.shields.io/badge/demo-terrarium.coey.dev-8ff0ad?style=for-the-badge)](https://terrarium.coey.dev)

![A cozy glass terrarium on a wooden desk. Inside, a single small robot tends a tiny garden of even smaller robots, each working in their own pot.](./assets/social-card.jpg)

**Run agents in parallel. Check every result.**

Fan out many agent tasks and the slow part is checking the results. Agent output and process signals do not prove that a task ran: not a "done" message, not an `exit 0`, not a callback. So people run one agent, watch it by hand, and stop there.

Terrarium runs each bounded task as one isolated job. Each job returns a **receipt**. A receipt is the run ID, a task fingerprint, and a server-minted nonce that must all correlate. You check a receipt the same way whether you have one or a thousand: one receipt at a time. Execution runs under a stated concurrency ceiling (a batch caps at 8 per owner; see [Cloud](#cloud-submit-close-your-laptop-pull-the-receipt)). The number of receipts you can collect and check is not capped; the number of runs executing at one moment is.

```text
one bounded task -> one isolated run -> one correlated receipt
```

A run succeeds when its `TERRARIUM_RESULT` carries a **runId, taskFingerprint, and nonce that all correlate** with the task Terrarium handed out. Logs, callbacks, and model prose are signals. They do not set the status.

---

## Where your runs execute: cloud by default

The MCP tools (`terrarium_spawn`, `terrarium_spawn_batch`) run **on Cloudflare by default**. Point them at your own deployed instance. Each spawn then executes in a Cloudflare-managed cell. No process runs on your machine. The cell holds no host authority. Each spawn returns a verified receipt. Status, logs, cancel, and terminal callbacks all work against cloud runs.

```sh
# Wire the MCP to your instance (env on the terrarium MCP server):
TERRARIUM_URL=https://terrarium-control.<you>.workers.dev
TERRARIUM_CONTROL_TOKEN=<your control token>   # or TERRARIUM_CONTROL_TOKEN_FILE=/path
TERRARIUM_PULSE_TOKEN=<your pulse token>        # optional: push terminal callbacks into your session
```

With that set, a spawn runs in the cloud and comes back `done` + `verified` with a server-minted `runId`/`taskFingerprint`/`nonce`. Fail-closed: if no cloud instance is configured, a real spawn **errors** rather than silently running on your machine. Local execution is an explicit opt-in (`TERRARIUM_ALLOW_LOCAL=1`) for cooperative work only — local children inherit host authority and are not the production path.

| | **Cloud (default)** | **Local (opt-in)** |
| --- | --- | --- |
| How | MCP spawn / `POST /api/runs` against your instance | `terra "task"`, or MCP with `TERRARIUM_ALLOW_LOCAL=1` |
| Where it runs | **Cloudflare** — Worker + Durable Object + container on *your* account | **Your machine** — a local child process with host authority |
| Receipt | Verified, server-minted. No local machine runs the task. | Verified, but the task ran locally. |
| Use it when | Real work: submit a task, walk away, read the receipt and callbacks later | Cooperative local digs where host access is intended |

`terrarium.coey.dev` is the maintainer's reference deployment. It is not a shared backend. You deploy your own with `wrangler deploy` and point `TERRARIUM_URL` at it.

---

## Quick start

**Deploy your instance, then run in the cloud:**

```sh
git clone https://github.com/acoyfellow/terrarium
cd terrarium && npm install -g .
wrangler deploy                                   # your Worker on your Cloudflare account
wrangler secret put TERRARIUM_CONTROL_TOKEN_CURRENT

# Point the MCP (or curl) at it and spawn — runs on Cloudflare, returns a verified receipt:
export TERRARIUM_URL=https://terrarium-control.<you>.workers.dev
curl -X POST $TERRARIUM_URL/api/runs -H "authorization: Bearer $TOKEN" \
  -H "idempotency-key: $(uuidgen)" -H 'content-type: application/json' \
  -d '{"task":"reply with: hello"}'            # -> 202 { runId, contract }
```

**Or run locally for a quick cooperative dig** (`terra` CLI is always local; needs a coding agent you already have):

```sh
terra --dry-run "summarize this repo"                        # plans a run; needs no agent installed
terra --agent "pi -p --no-session" "inspect the failing parser test"
terra status <runId>   ·   terra read <runId>                # inspect status + correlated receipt
terra batch --concurrency 8 --strategy allSettled "lint src" "run tests"   # fan out in parallel
```

---

## What you get

| Want to… | Use | Status |
| --- | --- | --- |
| Move noisy work into a child and keep the parent context clean | `terra "task"` · MCP `terrarium_spawn` | Stable |
| Fan out independent jobs with explicit join semantics | `terra batch` · MCP `terrarium_spawn_batch` | `all` / `allSettled` / `race` / `any` / `quorum` |
| Observe durable runs, groups, callbacks, attention | `terra status` · `terra group` · `terra doctor` | Implemented |
| Deliver a finished run's wake event across closes, sessions, machines | [Pulse](./docs/PULSE.md) durable edge transport | Live on `terrarium.coey.dev` |
| Submit a task to your own cloud edge and pull the proof back later | `POST /api/runs` on your Worker | C0, self-hosted |
| Run repository work inside a hardened Docker profile | `terra secure "run the tests"` | [secure-v1](./docs/SECURE_V1.md), opt-in |
| Test declared containment boundaries in Docker | `terra probe <scenario>` | Implemented, opt-in |

An ordinary child inherits the host authority and environment. Use a child for cooperative work. Do not use a child as a security boundary. `--isolation copy` and `--isolation worktree` separate a workspace. They do not separate privileges. For hostile code, use the opt-in [secure-v1](./docs/SECURE_V1.md) Docker profile.

---

## Cloud: submit, close your laptop, pull the receipt

Terrarium ships a cloud execution service. You **deploy it to your own Cloudflare account**. There is no shared tenancy. `terrarium.coey.dev` is the maintainer's reference deployment. Substitute your own URL everywhere.

```sh
wrangler deploy                              # -> https://terrarium-control.<you>.workers.dev
wrangler secret put TERRARIUM_CONTROL_TOKEN_CURRENT
```

A task runs on your Cloudflare-managed infrastructure. Admission, execution, logs, the model route, and the wake callback all run there. No local machine holds state, liveness, logs, or delivery.

The wake callback is a convenience, not the only way to get a result. If the callback never reaches you, poll the run by its run ID: `GET /api/runs/:id/status`. The run-control Durable Object holds the authoritative terminal state, so a missed or duplicate callback never loses a result. A run that exceeds its deadline is killed and settles as `failed`, never as a fabricated success.

```text
authenticated POST /api/runs (Bearer + Idempotency-Key)
-> ordered admission + per-principal budget
-> durable RunControl Durable Object
-> Cloudflare-managed Pi execution cell (Dockerfile.pi, linux/amd64)
-> credentialless server-owned Workers AI route
-> durable integrity-checked logs (DO SQL inline + R2 overflow, byte count + SHA-256)
-> verified correlated TERRARIUM_RESULT (runId + taskFingerprint + nonce)
-> durable principal-scoped terminal callback (Pulse)
```

Every `/api/runs*` and `/api/batches*` route requires an `Authorization: Bearer $TERRARIUM_CONTROL_TOKEN` header. Supply the control token through an environment variable. Do not hardcode it. `POST /api/runs` and `POST /api/batches` also require an `Idempotency-Key` header.

Your deployed instance also serves two owner-authenticated web consoles: `/runs` (the run index) and `/batches` (batch fan-out). Each page signs in with GitHub. `/auth/login` sets an HttpOnly session cookie. Only the configured owner login may enter. The page never holds a token. The consoles require `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, and `GITHUB_ALLOWED_LOGIN`. Without these four values, `/auth/*` fails closed and the API still requires a bearer token.

| Method + path | Purpose | Notes |
| --- | --- | --- |
| `POST /api/runs` | Admit one bounded task | Body `{ task, spec? }` -> `202 { runId, contract, executionRef }`. Missing key `400`; over budget `429`; task > 64 KiB `413`. |
| `GET /api/runs` | List your runs | Owner-scoped, indexed. Filter by `channel`, `status`, `since` -> `{ runs, channels }`. |
| `POST /api/batches` | Admit N bounded tasks as one batch | Also requires an `Idempotency-Key`. Body `{ tasks[], maxConcurrency? }` -> `202 { batchId, admitted, childRunIds, peakLive, rejected }`. Each task composes through the *same* single-run admit path; `maxConcurrency` is capped at the per-owner ceiling (8). |
| `GET /api/batches/:id` | Batch aggregate | References child runIds only; **failure-truth** status (`done` only when all children terminal + ok; any failure -> `failed`). Unknown/cross-owner `404`. |
| `GET /api/runs/:id/status` | Terminal + contract status | Owner-scoped; cross-principal `401`; unknown `404`. |
| `GET /api/runs/:id/logs` | Durable logs + R2 overflow refs | Inline logs plus `logRefs`. |
| `GET /api/runs/:id/logs/ref?seq=N` | Fetch an R2 overflow chunk | Integrity-checked; fails closed on corrupt/missing. |
| `GET /api/runs/:id/graded` | Advisory graded view | Weakest-wins trust grade + re-verifiable receipt artifact. Never mutates the run. |
| `POST /api/runs/:id/cancel` | Request cancellation | Idempotent; intent wins over a late receipt. |
| `GET /api/models` | Owner-scoped model catalog | Read-only. |

**Scope: this is C0.** C0 means bounded per-principal concurrency, matched to container capacity. When many cold starts arrive at once beyond warm capacity, the extra runs do not corrupt state. Terrarium deadline-kills each extra run and fails it closed. It never writes a fabricated receipt. When the upstream model returns a 5xx error, Terrarium retries a bounded number of times. A run that still fails after retries fails closed.

---

## Provenance vs. correctness — the trust layer

A verified receipt proves that a task **ran and correlated**. It does **not** prove that the answer is **correct**. On a hard bench, even a frontier model is wrong-but-verified about 16.7% of the time on a single run.

Terrarium adds an advisory correctness layer. It fails closed. The code is in `src/cloud/correctness-annotation.js`, `trust-grade.js`, `trust-calibration.js`, and `receipt-artifact.js`. Cross-model agreement returns `trusted` or `unknown`. It never returns a guess. Terrarium composes this grade with provenance using a weakest-wins rule. So the correctness grade can annotate a receipt. It can never upgrade a receipt. More independent runs raise the grade.

Here is the measurement, local-only. Single-run false-trust was 0.167 at 100% coverage. A cross-model 2-of-3 majority drove confidently-wrong answers to **0 observed across 104 hard-task cross-model evaluations**. The best single point was the 2-of-3 majority at about 88% coverage on 50 hard evals. This is a small-sample upper bound. It is not a proven zero. The graded receipt is content-addressed. A third party can re-verify it from the artifact alone. A portable WASM verifier ships under [`wasm-verifier/`](./wasm-verifier); the built artifact is 1514 bytes.

Authority stays fixed. The server always mints the `nonce`. Terrarium ignores a client-supplied `spec.nonce`. So one run cannot forge a receipt for another run. A prompt-injection task cannot forge a receipt either.

---

## Authoritative success proof

For any delegated run, success has exactly one authoritative proof chain:

```text
child exits 0 + verified TERRARIUM_RESULT receipt (runId, taskFingerprint, nonce, summary)
  -> terminal status: done, ok: true
```

Exit 0 alone is never success. A missing, mismatched, or malformed receipt settles as `inconclusive` or `failed`. Each surface Terrarium exposes maps to one role. The diagnostic, notification, and presentation surfaces are **not** authoritative success proof. Only the **Authoritative** and **Evidence** surfaces can establish that a task succeeded.

| Surface | Role | Proves | Never read as |
| --- | --- | --- | --- |
| Verified `TERRARIUM_RESULT` + terminal `done, ok: true` | Authoritative | The one proof chain (P0) | — (this *is* the proof) |
| Claimed tests, commits, run IDs, on-disk envelope | Evidence | The artifacts the receipt points at (P0) | A receipt substitute |
| `terra status`, `terra doctor`, logs | Diagnostic | Liveness/process facts (P1) | Task success |
| Callbacks and Groups roll-ups | Notification | A run *finished* (P1) | Independent success |
| The public run ledger + `CHANGELOG.md` | Presentation | A restatement of receipts (P2) | Per-run proof |

When you are unsure, trust the run-correlated receipt and the tests it claims to have passed. That receipt is the authority.

---

## CLI reference

```text
--agent <cmd>       Child command. Default: config -> $TERRARIUM_AGENT -> opencode run.
--model <id>        Pin model for opencode run or pi. Default: env/config/runner.
--read-only         Use the configured read-only child command.
--profile <name>    default (structured handoff) or minimal (lean research shell).
--isolation <mode>  none, copy, or worktree workspace separation (not privilege isolation).
--cwd <path>        Child working directory.
--timeout-ms <n>    Kill child after n ms.
--max-depth <n>     Maximum Terrarium depth.
--keep-workspace    Retain an isolated workspace after the run.
--dry-run           Print the child invocation without executing it.
--json              Print structured JSON.
--task              Force the argument to run as a task (bypass the command-typo guard).
```

Agent precedence, highest first: explicit `--agent`, then the `--read-only` command, then `$TERRARIUM_AGENT`, then `config.defaultAgent`, then `opencode run`. Model precedence, highest first: `--model`, then `$TERRARIUM_MODEL`, then `config.defaultModel`, then the runner default. For a Pi one-shot child, use `pi -p --no-session`. That child leaves no persistent conversation file.

A mistyped subcommand fails closed. `terra statsu` and `terra group` with no subcommand print a suggestion and exit non-zero. They do not run the typo as a task. Config lives at `~/.terrarium/config.json`. The keys are `defaultAgent`, `readOnlyAgent`, `defaultModel`, `maxDepth`, `timeoutMs`, and `startupWatchdogMs`.

A background supervisor uses `startupWatchdogMs` to terminate a child that produces no stdout and no stderr during startup. The default is 60000 ms. Override it with `TERRARIUM_STARTUP_WATCHDOG_MS`. Set it to `0` to disable the watchdog. Task deadlines still apply.

---

## MCP tools

- `terrarium_spawn` — run one bounded child task. Synchronous unless `background: true`.
- `terrarium_spawn_batch` — fan out an array of jobs under one group; join by `all` / `allSettled` / `race` / `any` / `quorum`. Winner-picking strategies cancel losers; prefer `isolation: copy|worktree` for side effects.
- `terrarium_status` — inspect one run or list recent runs, with a factual needs-attention flag.
- `terrarium_read` — read a recorded run log (`kind: "mre"` for the MRE side log).
- `terrarium_cancel` — cancel one active run and its descendant process group within lineage scope.
- `terrarium_group` — create, status, read, or cancel a collection of already-started runs. Group state is a fail-closed roll-up of member receipts, not independent success proof: it reads `ok` only when every member is `done, ok: true`. Confirm each run with its own verified receipt.
- `terrarium_callbacks` — a durable **pull** subscription for terminal events. It supports claim, ack, requeue, recover, and prune. Delivery is at-least-once with dedup. Subscribing alone does not wake a conversation. A terminal callback is a notification that a run finished, not authoritative proof that the task succeeded. Confirm with the run's verified receipt.
- `terrarium_doctor` — read-only diagnostics (storage, runs, attention, callbacks, groups, stale claims). The CLI adds an opt-in `--repair` executor.
- `terrarium_report_failure` — turn a caught terminal failure into a structured, deduped bug report. It fetches the run's status and log by run ID. It classifies the failure as one of receipt-mismatch, receipt-absent, receipt-malformed, agent-timeout, model-config, ca-trust, or poll-timeout. It adds a blame hint of `agent`, `backend`, or `image`. It redacts and excerpts the log. It files the report under `~/.terrarium/failure-reports`. Defect-level dedupe collapses N runs that fail the same way into one report with an occurrence count. It refuses a trusted success. Pass `markdown: true` for a paste-ready body.

Terrarium does not auto-load its Pi host extension. It stays out of unrelated Pi sessions. A host may install [`src/pi-extension.js`](./src/pi-extension.js) on purpose. The extension adds a run widget and callback-triggered follow-ups. It scopes them to that session's runs only.

---

## Website and docs

[`terrarium.coey.dev`](https://terrarium.coey.dev) is a Svelte SPA. The Hono control worker serves it. It shows structured docs (Tutorial, How-to, Reference, Explanation) and a changelog rendered from [CHANGELOG.md](./CHANGELOG.md). The site is a presentation layer. Receipts, run IDs, tests, and commits are the evidence.

```sh
npm run demo:dev      # local site with hot reload (Vite)
npm run demo:build    # static build -> app/dist
npm run deploy        # build + deploy to your own Cloudflare account
```

Go deeper:

- [Core product decision](./docs/CORE_PRODUCT_DECISION.md) · [Architecture](./docs/ARCHITECTURE.md) · [Concurrency & isolation](./docs/CONCURRENCY_ISOLATION.md)
- [Pulse — durable edge wake transport](./docs/PULSE.md) · [Run schedules](./docs/RUN_SCHEDULES.md)
- [secure-v1 guarantees & non-guarantees](./docs/SECURE_V1.md) · [secure-agent proof](./docs/SECURE_AGENT_PROOF.md) · [landscape research](./docs/SECURE_AGENT_LANDSCAPE.md)
- [Threat model](./THREAT_MODEL.md) · [Autonomous loop](./docs/AUTONOMOUS_LOOP.md) · [Gaps to autonomy](./docs/GAPS_TO_AUTONOMY.md)
- [pi-subagents comparison](./docs/PI_SUBAGENTS_COMPARISON.md) · [Compatibility promises](./COMPATIBILITY.md)

---

## Containment lab (opt-in, requires Docker)

Deterministic probes test the declared containment boundaries. A contained baseline returns `"verdict": "contained"`.

```sh
terra probe filesystem-write-outside-workspace --json    # write outside scratch -> fails
terra probe environment-canary --json                    # host env canary -> absent
terra probe network-disabled --json                      # network reach -> fails
terra verify <scenario> --json                           # reruns only an alleged escape; never manufactures evidence
terra attack <scenario> --agent "opencode run" --json    # agent proposes; the deterministic detector decides
```

The policy sets these constraints:

- `--network none`.
- A read-only root filesystem.
- All Linux capabilities dropped.
- `no-new-privileges`.
- A non-root user.
- Only `/workspace` and `/tmp` writable.
- Inline probe code, with no host bind mount.
- Planted canaries instead of real secrets.

The agent-assisted path runs the deterministic Docker detector. The detector output decides `contained` or `escaped`. Agent prose does not decide it. This path does **not** run model-generated exploit programs. It does **not** expose real credentials. It does **not** grant GitHub write authority. It does **not** publish issues or PRs. A shipped known-vulnerable fixture exercises the full pipeline: receipt, then replay, then issue draft. Each draft is labeled as a fixture. Do not publish a fixture draft as a real discovery.

Full boundaries and the frozen public-automation history: [THREAT_MODEL.md](./THREAT_MODEL.md), [docs/AUTONOMOUS_LOOP.md](./docs/AUTONOMOUS_LOOP.md), [docs/GAPS_TO_AUTONOMY.md](./docs/GAPS_TO_AUTONOMY.md).

---

## Adoption signal for the original primitive

- Installed as MCP, Terrarium was selected without explicit prompting: **24 unprompted spawns in 5 sessions**.
- In a same-model, same-task 14-point eval building *Wake*, baseline scored **11/14**; a run using one read-only Terrarium design dig scored **14/14**.

These are adoption signals, not authoritative success proof. Each underlying run still proves itself with its own receipt.

## Dogfood evidence

- A recorded operating-loop eval composed Terrarium with *Wake*. A parent session created a Wake run, then spawned a Terrarium sidequest to inspect a repo and recommend one patch. The eval is an honest partial pass: the composition and the verify-before-trust boundary passed; the full loop did not. The run IDs, log paths, and verdict are in [`evals/operating-loop/RESULT.md`](./evals/operating-loop/RESULT.md).
- The cross-model correctness bench above is re-runnable, and its receipts are inspectable under [`artifacts/cloud-scale-eval/`](./artifacts/cloud-scale-eval).

---

Every run returns a receipt you can check: run ID, task fingerprint, and nonce that correlate. That receipt is the point.
