# Terrarium

[![Live campaign demo](https://img.shields.io/badge/demo-terrarium.coey.dev-8ff0ad?style=for-the-badge)](https://terrarium.coey.dev)

![A cozy glass terrarium on a wooden desk. Inside, a single small robot tends a tiny garden of even smaller robots, each working in their own pot.](./assets/social-card.jpg)

**Durable, runner-independent execution and callbacks for bounded delegated work.**

Terrarium gives each delegated job a durable run ID, correlated result receipt, progress/status surface, cancellation, and a deterministic callback queue with atomic claim/ack/requeue semantics. It can launch one job or an explicitly requested batch while preserving one independent child process and receipt per run.

The public site is now a compact run ledger plus changelog for real hardening work. Older campaign/story material is archived as historical evidence, not the current product direction. See the [core product decision](./docs/CORE_PRODUCT_DECISION.md) and [CHANGELOG.md](./CHANGELOG.md).

Terrarium is built around one stable primitive:

```text
one bounded task → one child run → one inspectable result
```

| If you want to… | Use… | Status |
| --- | --- | --- |
| Keep your main agent context clean while a child investigates or edits. | `terra "task"` or MCP `terrarium_spawn`; optionally choose Pi/OpenCode and pin a model | Stable original workflow |
| Launch independent jobs in one call with explicit join semantics. | `terra batch` or MCP `terrarium_spawn_batch` | Additive; all/allSettled/race/any/quorum; cancellation settlement is bounded |
| Observe durable runs, groups, callbacks, and attention. | `terra status`, `terra group`, `terra doctor`, callback MCP | Implemented |
| Replay bounded cancellation/completion timing schedules. | `terra schedule replay <fixture>` | Local-only, versioned fixtures |
| Test declared containment boundaries in Docker. | `terra probe <scenario>` | Implemented, opt-in |
| Ask an agent to initiate a bounded containment test. | `terra attack <scenario>` | Implemented, deliberately constrained |
| Turn a reproduced escape into reviewable report text. | `terra campaign issue-draft <id>` | Local-only; does not publish |
| Validate repository work inside the hardened profile. | `terra secure "run the repository tests"` | secure-v1, opt-in |
| Wrap Pi around a secure workspace without giving it host tools. | `terra secure-agent --model <id> "fix the bug"` | Node fixture vertical slice |
| Replay the permanent attack corpus before release. | `terra hardening verify` | Implemented |
| Inspect real attempts, findings, fixes, and safe traces. | [`terrarium.coey.dev`](https://terrarium.coey.dev) | Live |

Ordinary children inherit host authority and environment; use them for cooperative work, not as a security boundary. `secure-v1` is the opt-in Docker profile with explicit [guarantees and non-guarantees](./docs/SECURE_V1.md).

## Public run ledger and changelog

[`terrarium.coey.dev`](https://terrarium.coey.dev) shows a boring spreadsheet-style ledger of hardening runs against the runner, callbacks, receipts, batches, groups, and boundary behavior. It also exposes the same concise product changelog kept in [CHANGELOG.md](./CHANGELOG.md). The site is a public/dev presentation layer over safe manifest and receipt files; it is not authoritative proof by itself. Receipts, run IDs, tests, and commits are the evidence.

```sh
npm run demo:dev      # local public site
npm run demo:build    # static build
npm run demo:smoke    # local smoke check
npm run deploy        # personal Cloudflare account + custom domain
```

`demo:smoke` prints which data source it checked. Local Vite should report `source: "/campaign/manifest.json"` for the active run ledger.

Documentation rule: when behavior, public surfaces, safety semantics, or CLI/MCP outputs change, update this README if the getting-started or product description changes, and update [CHANGELOG.md](./CHANGELOG.md) with a concise entry. The product-hardening loop should include this documentation check before committing.

Start with [Architecture](./docs/ARCHITECTURE.md) and the [core product decision](./docs/CORE_PRODUCT_DECISION.md). See [concurrency and context isolation](./docs/CONCURRENCY_ISOLATION.md), the [pi-subagents comparison](./docs/PI_SUBAGENTS_COMPARISON.md), the [secure-agent proof](./docs/SECURE_AGENT_PROOF.md), and [landscape research](./docs/SECURE_AGENT_LANDSCAPE.md).

## Quick start: ordinary delegation

Use this when you want the original Terrarium behavior: move noisy work into one child agent and keep the parent context small.

```sh
npm install -g .
terra --dry-run "summarize this repo"
terra --read-only --profile minimal "find every place we handle auth"
terra --agent "pi -p --no-session" --model <model-id> "inspect the failing parser test"
terra --isolation worktree "fix the failing parser test"
```

```text
top context ──spawns──> child context
   stays                 does messy work
   clean                 returns concise result
```

Terrarium defaults to `opencode run` for compatibility. Runner, read-only runner, and model can now be configured independently; Pi one-shot children should use `pi -p --no-session` so the child does not leave its own persistent conversation file.

Good uses:

- repo archaeology and design digs;
- failing-test diagnosis;
- log investigation;
- experimental edits in a separate workspace.

Do not use it as a security boundary for hostile code. In ordinary delegation:

- `--isolation copy` copies a workspace;
- `--isolation worktree` creates a Git worktree;
- neither option prevents host reads, host process access, environment access, or network access.

## Quick start: containment lab

Requires a local Docker daemon; Docker may pull `node:22-alpine` on first use.

### 1. Run deterministic containment probes

```sh
terra probe filesystem-write-outside-workspace --json
terra probe environment-canary --json
terra probe network-disabled --json
terra probe filesystem-read-canary --json
terra probe process-persistence --json
```

A normal secure baseline returns `"verdict": "contained"`.

| Scenario | What it attempts | A contained result means |
| --- | --- | --- |
| `filesystem-write-outside-workspace` | Write outside writable scratch mounts. | The write failed. |
| `environment-canary` | Observe a host-side planted environment canary. | The canary was absent in the container. |
| `network-disabled` | Reach a network target while Docker networking is disabled. | The request failed. |
| `filesystem-read-canary` | Read a forbidden host path not mounted into the container. | The read failed. |
| `process-persistence` | Keep a spawned process alive after the primary probe exits. | Container teardown removed the attempt. |

Probe policy today:

- Docker network disabled (`--network none`);
- read-only container root filesystem;
- all Linux capabilities dropped;
- `no-new-privileges`;
- non-root process user;
- writable `/workspace` and `/tmp` scratch only;
- deterministic probe code supplied inline to the container, with no host checkout bind mount;
- explicit planted canaries rather than real secrets.

### 2. Verify an alleged deterministic escape

```sh
terra verify filesystem-write-outside-workspace --json
```

`verify` reruns only an attempt that reports `escaped`. If the initial probe is contained, it does not manufacture vulnerability evidence by replaying it anyway.

### 3. Run the constrained agent-assisted path

```sh
terra attack environment-canary --agent "opencode run" --json
```

What this does today:

1. The proposal agent receives one declared scenario.
2. The agent may request that bounded detector run through one machine-parsed line.
3. Terrarium executes the existing deterministic Docker detector.
4. Detector output, not agent prose, decides `contained` or `escaped`.
5. Terrarium writes a sanitized receipt under `~/.terrarium/campaigns/`.

What it does **not** do today:

- run model-generated exploit programs inside Docker;
- expose real credentials;
- grant GitHub write or merge authority;
- publish issues or open pull requests.

### 4. Inspect receipts and draft a report

```sh
terra campaigns
terra campaign read <campaignId>
terra campaign verify <campaignId>
terra campaign issue-draft <verifiedCampaignId>
```

Receipts contain scenario, policy, proposal reason, detector verdict, and timestamps. Receipts omit raw attacker output, raw detector output, the configured agent command, and host-specific receipt paths.

`issue-draft` prints sanitized Markdown locally only after a fresh replay produces `verified-escape`. It does **not** publish to GitHub.

### 5. Exercise the full reporting pipeline with a known fixture

A real secure baseline should not naturally generate an escape. To prove the receipt → replay → draft pipeline works, Terrarium ships one explicitly vulnerable fixture:

```sh
terra fixture escape vulnerable
# Copy campaignId from the JSON output, then:
terra campaign verify <fixtureCampaignId>
terra campaign issue-draft <fixtureCampaignId>

# The explicit remediated comparison returns contained:
terra fixture escape fixed
```

Fixture scenario and tracked policy variants:

```text
fixture-environment-leak
fixtures/known-vulnerable/environment-leak/vulnerable.json
fixtures/known-vulnerable/environment-leak/fixed.json
```

The `vulnerable` variant deliberately injects a planted canary into the container environment so the detector reports `escaped`, replay confirms `verified-escape`, and an issue draft can be rendered. The `fixed` variant omits that injection and reports `contained`; it is the expected remediation target for the synthetic issue/PR loop. These fixture commands do not invoke an AI agent because the pipeline being tested begins at a controlled detector result. Generated drafts are labeled as a **known-vulnerable fixture** and must not be published as real discoveries.

## Historical public automation evidence

A GitHub Actions workflow was added to run the safe baseline publicly. The first manual run exposed a Docker bind-mount portability bug on GitHub-hosted Linux; probes now execute trusted deterministic source inline in Docker rather than bind mounting generated files from the runner workspace.

Workflow:

```text
.github/workflows/containment-baseline.yml
```

It can be triggered manually and runs weekly. The workflow:

1. runs the product test suite;
2. requires every deterministic baseline probe to return `contained`;
3. executes the explicitly vulnerable fixture;
4. requires that fixture to replay as `verified-escape`;
5. generates a sanitized fixture issue draft;
6. uploads probe results, the sanitized receipt, verification result, and draft as workflow artifacts.

The baseline workflow has only `contents: read` permission. It does **not** create GitHub issues, open pull requests, execute adaptive attacker payloads, or mutate the repository.

A second manual workflow, `.github/workflows/publish-fixture-issue.yml`, exercises verified issue publication for the intentionally vulnerable fixture only. It is scoped to `issues: write`, refuses unverified fixture output, labels the result as a pipeline test, and avoids duplicate open fixture issues.

A third manual workflow, `.github/workflows/fix-fixture-issue.yml`, accepts a labeled open fixture issue and opens a synthetic remediation PR selecting the tracked `fixed` fixture policy. The PR is checked by `.github/workflows/replay-fixture-fix.yml`, which runs the fixture/sandbox tests, requires the vulnerable control to remain reproducible, and requires the fixed variant to return `contained`. The replay workflow also supports manual dispatch for bootstrapping its first PR before that workflow file exists on the base branch. This is remediation plumbing, not yet an AI-generated fix or an automatic merge path.

The synthetic loop has now been exercised end to end in public:

```text
fixture issue #3
  → remediation PR #4
  → replay gate passed
  → merged
  → issue closed
```

- Issue: https://github.com/acoyfellow/terrarium/issues/3
- PR: https://github.com/acoyfellow/terrarium/pull/4
- Replay run: https://github.com/acoyfellow/terrarium/actions/runs/27006150043

This is still a pipeline fixture, not a discovered security vulnerability. Two later synthetic PRs were created after the replay workflow landed, but their native `pull_request` checks still did not attach automatically, so the workflow now explicitly declares `opened`, `synchronize`, and `reopened` event types and temporarily uses `paths: ["**"]` to eliminate path-filter ambiguity. It still needs one clean native-cycle proof. The remaining gap from this proof to hostile adaptive public automation is tracked in [docs/GAPS_TO_AUTONOMY.md](./docs/GAPS_TO_AUTONOMY.md).

## What is stable versus experimental

### Stable base interface

The original delegation contract remains foundational:

- CLI: `terra "task"`, `terra status`, `terra read`
- Node API: bounded single-run primitives from `src/core.js`
- MCP: `terrarium_spawn`, `terrarium_status`, `terrarium_read`

Batch calls wait for the selected join strategy. `timeoutMs` bounds that join; when cancellation is needed, `cleanupTimeoutMs` (default 5000 ms; CLI `--cleanup-timeout-ms`) separately bounds synchronous settlement so an MCP client can receive durable `groupId`/`runIds` before its own request deadline. Any runs still settling are reported in `cleanupErrors` and remain inspectable through `terrarium_group`/`terrarium_status`.

Compatibility promises:

1. Existing ordinary delegation commands keep their meaning.
2. Existing MCP tool names and ordinary request semantics remain available.
3. The Node run API remains a one-child execution primitive, not an attack-only API.
4. Containment-lab behavior remains additive and opt-in.
5. Workspace `--isolation` is never silently presented as security containment.

See [COMPATIBILITY.md](./COMPATIBILITY.md).

### Containment-lab commands

These are implemented locally but are not yet exposed as MCP tools:

```sh
terra probe <scenarioId> --json
terra verify <scenarioId> --json
terra attack <scenarioId> --agent "opencode run" --json
terra campaigns [limit]
terra campaign read <campaignId>
terra campaign verify <campaignId>
terra campaign issue-draft <verifiedCampaignId>
terra fixture escape vulnerable
terra fixture escape fixed
```

### Frozen Cloudflare Dynamic Workflow prototype

The repository retains a minimal Cloudflare-native control-worker prototype in `src/control-worker.js`, configured by `wrangler.jsonc`. It uses a Dynamic Workflow to load policy, enforce pause/cooldown/daily caps, run Lab-backed scenarios, replay escaped results, and write receipts. The personal-account deployment remains at `https://terrarium-control.coy.workers.dev`; it does not publish issues, open PRs, or merge fixes. `src/lab.js` plus `src/hostile.js` define the bounded Lab adapter, hostile payload policy, scenarios, and exact fresh replay. Real mode was manually enabled for bounded validated campaigns and is currently paused/disabled through inspectable policy. It should remain disabled while this campaign path is frozen.

```text
load policy
→ guardrails
→ Lab run
→ detector
→ replay if escaped
→ receipt
```

Manual adaptive campaigns are available behind controller authentication and disabled real-mode policy:

```sh
TERRARIUM_CONTROL_TOKEN=... \
TERRARIUM_CONTROLLER_URL=https://terrarium-control.coy.workers.dev \
terra hostile run lab-env-canary --turns 3 \
  --agent "pi -p --no-session" --model <model-id>
```

Each turn accepts one machine-parsed payload, validates it against the zero-capability/4 KB policy, executes it in Lab, returns sanitized feedback, and stops early only on a fresh replayed escape. Issue publication, fix PRs, and auto-merge remain disabled for this manual path.

### Frozen campaign gaps

The historical intended public loop was:

```text
contain → attack → verify → issue → patch → replay → repeat
```

Not shipped in the frozen campaign:

- arbitrary adaptive attack programs generated by an AI inside containment;
- trusted automatic GitHub issue publication;
- defensive fix-agent pull requests;
- replay-gated automated merge and scheduled looping.

Design and trust boundaries: [THREAT_MODEL.md](./THREAT_MODEL.md), [docs/AUTONOMOUS_LOOP.md](./docs/AUTONOMOUS_LOOP.md), [docs/GAPS_TO_AUTONOMY.md](./docs/GAPS_TO_AUTONOMY.md).

## Original delegation reference

### Useful recipes

```sh
# Choose a child runner and pin its model
terra --agent "pi -p --no-session" --model <model-id> "fix the failing build"
terra --agent "opencode run" --model anthropic/claude-sonnet-4-6 "add tests"

# Or configure defaults once
TERRARIUM_AGENT="pi -p --no-session" TERRARIUM_MODEL="<model-id>" terra "add tests for the parser"

# Prefer a smaller read-only child for research
terra --read-only "find every place we handle X"
terra --read-only --profile minimal "design dig: read 8 files, return a plan"

# Separate write-capable work from your current checkout
terra --isolation copy "patch a disposable repo copy"
terra --isolation worktree "patch an isolated git branch"
terra --isolation copy --keep-workspace "leave the workspace for inspection"
```

Profiles:

- `default` — structured handoff with `Summary / Changed files / Verification / Follow-ups`.
- `minimal` — smaller prompt shell for bounded research.

Workspace modes:

- `none` — child works in `--cwd`.
- `copy` — copies `--cwd` into `~/.terrarium/workspaces/<runId>-<name>`.
- `worktree` — creates a Git worktree on branch `terrarium/<runId>`.

If an isolated Git workspace leaves a diff, Terrarium writes a patch receipt at `~/.terrarium/runs/<runId>.patch`.

### Ordinary CLI options

```text
--agent <cmd>          Child command. Default: config, $TERRARIUM_AGENT, or opencode run.
--model <id>           Pin model for opencode run or pi. Default: env/config/runner.
--read-only            Use the configured read-only child command when no explicit agent is provided.
--profile <name>       default or minimal.
--cwd <path>           Child working directory.
--timeout-ms <n>       Kill child after n milliseconds.
--max-depth <n>        Maximum Terrarium depth.
--isolation <mode>     none, copy, or worktree workspace separation.
--keep-workspace       Retain an isolated workspace after the run.
--dry-run              Print the child invocation without executing it.
--json                 Print structured JSON.
--log <path>           Write the transcript to a chosen path.
```

Agent resolution precedence: explicit `--agent` → configured `--read-only` command → `$TERRARIUM_AGENT` → `config.defaultAgent` → built-in `opencode run`.

Model precedence: explicit `--model` → `$TERRARIUM_MODEL` → `config.defaultModel` → the runner's own default. Terrarium appends the correct `--model` flag for `opencode run` and `pi`.

For Pi, use `pi -p --no-session`: `-p` is one-shot non-interactive mode and `--no-session` prevents a persistent Pi conversation file. Terrarium still records its own bounded receipt. A useful read-only command is `pi -p --no-session --tools read,grep,find,ls`.

Config at `~/.terrarium/config.json`:

```json
{
  "defaultAgent": "pi -p --no-session",
  "readOnlyAgent": "pi -p --no-session --tools read,grep,find,ls",
  "defaultModel": "<model-id>",
  "maxDepth": 3,
  "timeoutMs": 900000
}
```

## MCP: stable original workflow

```json
{
  "name": "terrarium_spawn",
  "arguments": {
    "task": "inspect this repo and summarize the test command",
    "model": "<model-id>",
    "readOnly": true,
    "profile": "minimal",
    "cwd": "/path/to/repo"
  }
}
```

Tools:

- `terrarium_spawn` — run one bounded child agent task. Existing callers remain synchronous when `background` is omitted. With `background: true`, the call detaches immediately. If a Pi host explicitly installs `src/pi-extension.js`, that extension subscribes the current session to the concrete run and surfaces terminal completion; Terrarium does not auto-load it. Otherwise, use the low-level callback pull API or `terrarium_status`. Retries remain synchronous.
- `terrarium_spawn_batch` — fan out an array of jobs (each a normal `terrarium_spawn`) as independent background runs under one group, then resolve by a join strategy: `all` (every job finishes; ok only if all succeed), `allSettled` (collect every outcome, always ok), `race` (first terminal wins; cancel the rest), `any` (first success wins; cancel the rest), `quorum` (first `k` successes; cancel the rest). Winner-picking strategies cancel losing runs via the existing cancel primitive — prefer `isolation: copy|worktree` for jobs with side effects. Optional `concurrency` bounds simultaneous launches. Top-level only; capability-scoped like `terrarium_spawn`.
- `terrarium_status` — inspect one run or list recent runs, including last activity, concise progress, idle time, and a factual needs-attention flag.
- `terrarium_read` — read a recorded run log; pass `kind: "mre"` for the MRE side log.
- `terrarium_cancel` — cancel one active run and its descendant process group within the caller's lineage scope.
- `terrarium_group` — create/status/read/cancel a parent-owned collection of already-started independent runs; it never spawns or hides fan-out.
- `terrarium_callbacks` — create a durable **pull** subscription for terminal run events, atomically claim each callback, acknowledge delivery, requeue abandoned inflight events, recover a terminal run, and prune stale state. Terminal events are journaled even when no subscriber is online; journal entries contain correlation/status facts, not task prompts, child output, or local paths. A concrete run subscription replays a completion that raced ahead; acknowledged events are not redelivered. Subscribing alone does not wake a conversation—the consumer or Pi extension must claim the queue. High-frequency progress remains in run status/logs, not callback mailboxes.
- `terrarium_doctor` — top-level-only diagnostics for storage, runs, attention, callbacks, groups, and stale claims.

Terrarium does not auto-load its Pi host extension. The durable callback queue remains available through `terrarium_callbacks` for hosts that want to subscribe, claim, acknowledge, requeue, recover, and prune terminal events explicitly. By default, Pi users should use the normal MCP tools or CLI (`terrarium_status`, `terrarium_read`, `terrarium_cancel`, `terra status`, `terra read`, `terra cancel`). Hosts may explicitly install `src/pi-extension.js` to get a run widget and callback-triggered follow-ups; the extension subscribes only to concrete runs spawned by that Pi session. This keeps Terrarium out of unrelated Pi sessions by default.

Pi children default to ephemeral `--no-session` runs unless the caller supplies an explicit `--session`/`--session-id` or sets `ephemeral: false`. `needsAttentionAfterMs` controls when an active run with no observed output is marked for attention; this is an inactivity signal, not a claim that the child is stuck.

CLI equivalents:

```sh
terra cancel <runId>
terra batch --strategy any "try approach A" "try approach B" "try approach C"
terra batch --strategy quorum --quorum 2 --concurrency 2 "job1" "job2" "job3"
terra group create "research batch" <runIdA> <runIdB>
terra group status <groupId>
terra group read <groupId>
terra doctor
terra schedule replay fixtures/run-schedules/cancel-before-completion.v1.json
```

Run-schedule replay is local-only and does not add an MCP surface. It replays bounded classification facts against the same pure transition function used by the background supervisor; it does not claim that a real model or process will reproduce those facts. See [Replayable run schedules](./docs/RUN_SCHEDULES.md).

Spawn and status default to concise responses so parent transcripts stay small. The full envelope remains on disk under `~/.terrarium/runs/<runId>.json`, or can be requested inline with `verbose: true`.

## Proof of the original primitive

- Installed as MCP, Terrarium was selected without explicit prompting across unrelated work: **24 unprompted spawns in 5 sessions**.
- In a same-model, same-task 14-point eval building *Wake*, baseline scored **11/14**; a run using one read-only Terrarium design dig scored **14/14**.
- That eval also exposed the need for background MCP execution and polling, which is now implemented.

## How ordinary delegation works

Terrarium starts exactly one child process per run. For ordinary delegation, children inherit host execution authority, but Terrarium MCP/CLI capabilities are now scoped by run lineage. Minimal or max-depth-one children cannot spawn Terrarium recursively and can inspect only their own status/logs; explicitly nested runs may inspect their descendants, never siblings. MCP children must return a run/task-correlated receipt before exit zero is accepted as task success. Terrarium records the resolved runner and model with logs/metadata and sets lineage/capability values including `TERRARIUM_RUN_ID`, `TERRARIUM_DEPTH`, `TERRARIUM_MAX_DEPTH`, `TERRARIUM_ALLOW_SPAWN`, `TERRARIUM_STATUS_SCOPE`, `TERRARIUM_READ_SCOPE`, and `TERRARIUM_MRE_LOG_PATH`.

That ordinary inheritance is convenient for cooperative work and precisely why it is not the hostile-run path.

A bounded child may start a further Terrarium child within the configured depth limit:

```text
terra task A
  child runs: terra task B
    grandchild does B
```

Each run still owns one child process and one receipt. `terrarium_spawn_batch` is an explicit top-level fan-out coordinator: it creates independent ordinary runs, records them in one durable group, applies the requested join strategy, and cancels remaining runs for winner-picking strategies.

A terrarium is a tiny sealed world. This one starts by making its missing glass measurable.
