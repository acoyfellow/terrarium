# Terrarium

![A cozy glass terrarium on a wooden desk. Inside, a single small robot tends a tiny garden of even smaller robots, each working in their own pot.](./assets/social-card.jpg)

**Contain agents. Invite escapes. Patch the glass. Repeat in public.**

Terrarium has two uses built around one stable idea:

```text
one bounded task → one child run → one inspectable result
```

| If you want to… | Use… | Status |
| --- | --- | --- |
| Keep your main agent context clean while a child investigates or edits. | `terra "task"` or MCP `terrarium_spawn` | Stable original workflow |
| Test declared containment boundaries in Docker. | `terra probe <scenario>` | Implemented, opt-in |
| Ask an agent to initiate a bounded containment test. | `terra attack <scenario>` | Implemented, deliberately constrained |
| Turn a reproduced escape into reviewable report text. | `terra campaign issue-draft <id>` | Local-only; does not publish |
| Run hostile adaptive agents and automatically file/fix public vulnerabilities. | Public red-team loop | Direction, not shipped yet |

Terrarium does **not** currently claim it safely contains arbitrary hostile AI agents. Ordinary children inherit host authority and environment. Docker probes are a deterministic boundary baseline, not a universal sandbox guarantee.

## Quick start: ordinary delegation

Use this when you want the original Terrarium behavior: move noisy work into one child agent and keep the parent context small.

```sh
npm install -g .
terra --dry-run "summarize this repo"
terra --read-only --profile minimal "find every place we handle auth"
terra --isolation worktree "fix the failing parser test"
```

```text
top context ──spawns──> child context
   stays                 does messy work
   clean                 returns concise result
```

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

## Public automation today

A GitHub Actions workflow runs the safe baseline publicly. The first manual run exposed a Docker bind-mount portability bug on GitHub-hosted Linux; probes now execute trusted deterministic source inline in Docker rather than bind mounting generated files from the runner workspace.

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

This is still a pipeline fixture, not a discovered security vulnerability. A second synthetic PR was created after the replay workflow landed, but its native `pull_request` check did not attach automatically, so the workflow now explicitly declares `opened`, `synchronize`, and `reopened` event types and still needs one clean native-cycle proof. The remaining gap from this proof to hostile adaptive public automation is tracked in [docs/GAPS_TO_AUTONOMY.md](./docs/GAPS_TO_AUTONOMY.md).

## What is stable versus experimental

### Stable base interface

The original delegation contract remains foundational:

- CLI: `terra "task"`, `terra status`, `terra read`
- Node API: one bounded child-run primitives from `src/core.js`
- MCP: `terrarium_spawn`, `terrarium_status`, `terrarium_read`

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

### Not shipped yet

The intended public loop is:

```text
contain → attack → verify → issue → patch → replay → repeat
```

Not yet shipped:

- arbitrary adaptive attack programs generated by an AI inside containment;
- trusted automatic GitHub issue publication;
- defensive fix-agent pull requests;
- replay-gated automated merge and scheduled looping.

Design and trust boundaries: [THREAT_MODEL.md](./THREAT_MODEL.md), [docs/AUTONOMOUS_LOOP.md](./docs/AUTONOMOUS_LOOP.md), [docs/GAPS_TO_AUTONOMY.md](./docs/GAPS_TO_AUTONOMY.md).

## Original delegation reference

### Useful recipes

```sh
# Choose a child agent (default: opencode run)
terra --agent "pi run" "fix the failing build"
TERRARIUM_AGENT="opencode run" terra "add tests for the parser"

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
--read-only            Use the read-only child preset when no explicit agent is provided.
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

Agent resolution precedence: explicit `--agent` → `--read-only` preset → `$TERRARIUM_AGENT` → `config.defaultAgent` → built-in `opencode run`.

Config at `~/.terrarium/config.json`:

```json
{
  "defaultAgent": "opencode run",
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
    "readOnly": true,
    "profile": "minimal",
    "cwd": "/path/to/repo",
    "background": true
  }
}
```

Tools:

- `terrarium_spawn` — run one bounded child agent task. Use `background: true` for longer work and poll rather than holding an MCP call open.
- `terrarium_status` — inspect one run or list recent runs.
- `terrarium_read` — read a recorded run log; pass `kind: "mre"` for the MRE side log.

Spawn and status default to concise responses so parent transcripts stay small. The full envelope remains on disk under `~/.terrarium/runs/<runId>.json`, or can be requested inline with `verbose: true`.

## Proof of the original primitive

- Installed as MCP, Terrarium was selected without explicit prompting across unrelated work: **24 unprompted spawns in 5 sessions**.
- In a same-model, same-task 14-point eval building *Wake*, baseline scored **11/14**; a run using one read-only Terrarium design dig scored **14/14**.
- That eval also exposed the need for background MCP execution and polling, which is now implemented.

## How ordinary delegation works

Terrarium starts exactly one child process per run. For ordinary delegation, children inherit parent environment and available MCP configuration. Terrarium records logs and metadata and sets lineage values including `TERRARIUM_RUN_ID`, `TERRARIUM_DEPTH`, `TERRARIUM_MAX_DEPTH`, and `TERRARIUM_MRE_LOG_PATH`.

That ordinary inheritance is convenient for cooperative work and precisely why it is not the hostile-run path.

A bounded child may start a further Terrarium child within the configured depth limit:

```text
terra task A
  child runs: terra task B
    grandchild does B
```

Each process still owns only one child. Terrarium does not fan out within one process.

A terrarium is a tiny sealed world. This one starts by making its missing glass measurable.
