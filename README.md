# Terrarium

[![Live demo](https://img.shields.io/badge/demo-terrarium.coey.dev-8ff0ad?style=for-the-badge)](https://terrarium.coey.dev)

![A cozy glass terrarium on a wooden desk. Inside, a single small robot tends a tiny garden of even smaller robots, each working in their own pot.](./assets/social-card.jpg)

**Run agents in parallel. Trust every result.**

The thing blocking agents at scale isn't compute — it's trust. An agent that says "done" is not evidence. `exit 0` is not evidence. A callback firing is not evidence. So people run one agent, watch it, and never fan out.

Terrarium runs each bounded task as one isolated job and hands back a **verified receipt** — proof the run happened, correlated and yours to trust or reject. Trust one run the same way you trust a thousand: individually, by proof.

```text
one bounded task → one isolated run → one correlated receipt
```

Success is not `exit 0`, not a callback, not model prose. Success is a `TERRARIUM_RESULT` whose server-minted **runId, taskFingerprint, and nonce all correlate** with the task Terrarium handed out. Everything else is a signal, not proof.

---

## Where your runs execute — cloud by default

The MCP (`terrarium_spawn`, `terrarium_spawn_batch`) runs **on Cloudflare by default**. Point it at your own deployed instance and every spawn executes in a Cloudflare-managed cell — no process on your machine, no host authority — and returns a verified receipt. Status, logs, cancel, and terminal callbacks all work against cloud runs.

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
| Receipt | verified, server-minted, no local machine in the loop | verified, but executed locally |
| Use it when | Real work: submit, walk away, pull the proof (and callbacks) later | Cooperative local digs where host access is intended |

`terrarium.coey.dev` is the maintainer's reference deployment, not a shared backend — you deploy your own (`wrangler deploy`) and point `TERRARIUM_URL` at it.

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

Ordinary children inherit host authority and environment — use them for cooperative work, **not** as a security boundary. `--isolation copy|worktree` separates a *workspace*, not privileges. For hostile code, use the opt-in [secure-v1](./docs/SECURE_V1.md) Docker profile.

---

## Cloud: submit, close your laptop, pull the receipt

Terrarium ships a cloud execution service you **deploy to your own Cloudflare account** — no shared tenancy. `terrarium.coey.dev` is only the maintainer's reference deployment; substitute your own URL everywhere.

```sh
wrangler deploy                              # → https://terrarium-control.<you>.workers.dev
wrangler secret put TERRARIUM_CONTROL_TOKEN_CURRENT
```

A task runs entirely on your Cloudflare-managed infrastructure — admission, execution, logs, model route, and the wake callback. No local machine is required for correctness, liveness, logs, or delivery.

```text
authenticated POST /api/runs (Bearer + Idempotency-Key)
→ ordered admission + per-principal budget
→ durable RunControl Durable Object
→ Cloudflare-managed Pi execution cell (Dockerfile.pi, linux/amd64)
→ credentialless server-owned Workers AI route
→ durable integrity-checked logs (DO SQL inline + R2 overflow, byte count + SHA-256)
→ verified correlated TERRARIUM_RESULT (runId + taskFingerprint + nonce)
→ durable principal-scoped terminal callback (Pulse)
```

All `/api/runs*` require an `Authorization` header of the form `Bearer $TERRARIUM_CONTROL_TOKEN` (your control token, supplied via env — never hardcoded); `POST /api/runs` also requires an `Idempotency-Key`.

| Method + path | Purpose | Notes |
| --- | --- | --- |
| `POST /api/runs` | Admit one bounded task | Body `{ task, spec? }` → `202 { runId, contract, executionRef }`. Missing key `400`; over budget `429`; task > 64 KiB `413`. |
| `GET /api/runs/:id/status` | Terminal + contract status | Owner-scoped; cross-principal `401`; unknown `404`. |
| `GET /api/runs/:id/logs` | Durable logs + R2 overflow refs | Inline logs plus `logRefs`. |
| `GET /api/runs/:id/logs/ref?seq=N` | Fetch an R2 overflow chunk | Integrity-checked; fails closed on corrupt/missing. |
| `GET /api/runs/:id/graded` | Advisory graded view | Weakest-wins trust grade + re-verifiable receipt artifact. Never mutates the run. |
| `POST /api/runs/:id/cancel` | Request cancellation | Idempotent; intent wins over a late receipt. |
| `GET /api/models` | Owner-scoped model catalog | Read-only. |

**Honest scope:** this is C0 — bounded per-principal concurrency matched to container capacity. Broad simultaneous cold starts beyond warm capacity degrade gracefully (excess runs are deadline-killed, fail-closed, never a fabricated receipt). Intermittent upstream model 5xx is mitigated by bounded retry; residual failures fail closed.

---

## Provenance vs. correctness — the trust layer

A verified receipt proves a task **ran and correlated**. It does **not** prove the answer is **correct**. On a hard bench even a frontier model is wrong-but-verified ~16.7% of the time single-run.

Terrarium adds an **advisory, fail-closed correctness layer** (`src/cloud/correctness-annotation.js`, `trust-grade.js`, `trust-calibration.js`, `receipt-artifact.js`): cross-model agreement yields `trusted | unknown` (never a guess), composed **weakest-wins** with provenance so correctness can *annotate* but never *upgrade* a receipt. Parallelism helps here too — more independent runs raise confidence.

Measured locally on a hard bench, cross-model 2-of-3 majority drove confidently-wrong answers to **0 observed across 100+ hard-task evaluations at ~90% coverage** — a small-sample upper bound, not a proven zero. The graded receipt is content-addressed and re-verifiable by a third party from the artifact alone (a ~1.5 KB portable WASM verifier ships under [`wasm-verifier/`](./wasm-verifier)).

Authority stays invariant: the `nonce` is always server-minted (a client-supplied `spec.nonce` is ignored), so a run — or a prompt-injection task — cannot forge a receipt for another run.

---

## Authoritative success proof

For any delegated run, success has exactly one authoritative proof chain:

```text
child exits 0 + verified TERRARIUM_RESULT receipt (runId, taskFingerprint, nonce, summary)
  → terminal status: done, ok: true
```

Exit 0 alone is never success: a missing, mismatched, or malformed receipt settles as `inconclusive` or `failed`. Every surface Terrarium exposes maps to exactly one role, and the diagnostic, notification, and presentation surfaces are deliberately **not** authoritative success proof. Only **Authoritative** and **Evidence** can establish that a task succeeded:

| Surface | Role | Proves | Never read as |
| --- | --- | --- | --- |
| Verified `TERRARIUM_RESULT` + terminal `done, ok: true` | Authoritative | The one proof chain (P0) | — (this *is* the proof) |
| Claimed tests, commits, run IDs, on-disk envelope | Evidence | The artifacts the receipt points at (P0) | A receipt substitute |
| `terra status`, `terra doctor`, logs | Diagnostic | Liveness/process facts (P1) | Task success |
| Callbacks and Groups roll-ups | Notification | A run *finished* (P1) | Independent success |
| The public run ledger + `CHANGELOG.md` | Presentation | A restatement of receipts (P2) | Per-run proof |

When in doubt, the run/task-correlated receipt — and the tests it claims to have passed — is the source of truth.

---

## CLI reference

```text
--agent <cmd>       Child command. Default: config → $TERRARIUM_AGENT → opencode run.
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

Precedence — agent: explicit `--agent` → `--read-only` command → `$TERRARIUM_AGENT` → `config.defaultAgent` → `opencode run`. Model: `--model` → `$TERRARIUM_MODEL` → `config.defaultModel` → runner default. For Pi one-shot children use `pi -p --no-session` so the child leaves no persistent conversation file.

Mistyped subcommands fail closed (`terra statsu`, `terra group` with no subcommand) — they suggest and exit non-zero rather than silently running the typo as a task. Config lives at `~/.terrarium/config.json` (`defaultAgent`, `readOnlyAgent`, `defaultModel`, `maxDepth`, `timeoutMs`, `startupWatchdogMs`).

Background supervisors use `startupWatchdogMs` (default 60000, or `TERRARIUM_STARTUP_WATCHDOG_MS`) to terminate a child that produces no stdout or stderr during startup; set it to `0` to disable — task deadlines still apply.

---

## MCP tools

- `terrarium_spawn` — run one bounded child task. Synchronous unless `background: true`.
- `terrarium_spawn_batch` — fan out an array of jobs under one group; join by `all` / `allSettled` / `race` / `any` / `quorum`. Winner-picking strategies cancel losers; prefer `isolation: copy|worktree` for side effects.
- `terrarium_status` — inspect one run or list recent runs, with a factual needs-attention flag.
- `terrarium_read` — read a recorded run log (`kind: "mre"` for the MRE side log).
- `terrarium_cancel` — cancel one active run and its descendant process group within lineage scope.
- `terrarium_group` — create/status/read/cancel a collection of already-started runs. Group state is a fail-closed roll-up of member receipts (`ok` only when every member is `done, ok: true`); it is **not independent success proof** — confirm with each run's verified receipt.
- `terrarium_callbacks` — durable **pull** subscription for terminal events: claim, ack, requeue, recover, prune. At-least-once with dedup; subscribing alone does not wake a conversation. A terminal callback is a notification that a run finished, **not authoritative proof** the task succeeded; confirm with the run's verified receipt.
- `terrarium_doctor` — read-only diagnostics (storage, runs, attention, callbacks, groups, stale claims). The CLI adds an opt-in `--repair` executor.

Terrarium does not auto-load its Pi host extension — it stays out of unrelated Pi sessions. Hosts may explicitly install [`src/pi-extension.js`](./src/pi-extension.js) for a run widget and callback-triggered follow-ups scoped only to that session's runs.

---

## Website and docs

[`terrarium.coey.dev`](https://terrarium.coey.dev) is a Svelte SPA served by the Hono control worker — structured docs (Tutorial / How-to / Reference / Explanation) and a changelog rendered from [CHANGELOG.md](./CHANGELOG.md). It's a presentation layer; receipts, run IDs, tests, and commits are the evidence.

```sh
npm run demo:dev      # local site with hot reload (Vite)
npm run demo:build    # static build → app/dist
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

Deterministic probes assert declared containment boundaries; a contained baseline returns `"verdict": "contained"`.

```sh
terra probe filesystem-write-outside-workspace --json    # write outside scratch → fails
terra probe environment-canary --json                    # host env canary → absent
terra probe network-disabled --json                      # network reach → fails
terra verify <scenario> --json                           # reruns only an alleged escape; never manufactures evidence
terra attack <scenario> --agent "opencode run" --json    # agent proposes; the deterministic detector decides
```

Policy: `--network none`, read-only root fs, all Linux capabilities dropped, `no-new-privileges`, non-root user, writable `/workspace` + `/tmp` only, inline probe code (no host bind mount), planted canaries rather than real secrets.

The agent-assisted path executes the deterministic Docker detector — detector output, not agent prose, decides `contained` / `escaped`. It does **not** run model-generated exploit programs, expose real credentials, grant GitHub write authority, or publish issues/PRs. A shipped known-vulnerable fixture exercises the full receipt → replay → issue-draft pipeline; drafts are labeled as fixtures and must not be published as real discoveries.

Full boundaries and the frozen public-automation history: [THREAT_MODEL.md](./THREAT_MODEL.md), [docs/AUTONOMOUS_LOOP.md](./docs/AUTONOMOUS_LOOP.md), [docs/GAPS_TO_AUTONOMY.md](./docs/GAPS_TO_AUTONOMY.md).

---

## Adoption signal for the original primitive

- Installed as MCP, Terrarium was selected without explicit prompting: **24 unprompted spawns in 5 sessions**.
- In a same-model, same-task 14-point eval building *Wake*, baseline scored **11/14**; a run using one read-only Terrarium design dig scored **14/14**.

---

A terrarium is a tiny sealed world. This one starts by making its missing glass measurable.
