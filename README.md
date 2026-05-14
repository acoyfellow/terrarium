# Terrarium

![A cozy glass terrarium on a wooden desk. Inside, a single small robot tends a tiny garden of even smaller robots, each working in their own pot.](./assets/social-card.jpg)

**One task. One child. One level deep.**

```text
top context ──spawns──> child context
   stays                 does messy work
   clean                 returns concise result
```

Big agent runs die by context erosion. Terrarium treats context like a root plant: keep the top alive, push messy work into smaller pots, report back. The parent stays clean. The child does the dig. No fan-out, no unbounded recursion.

## Proof

**Two things, neither of them vibes.**

**1. The agent reaches for it on its own.** I installed Terrarium as an MCP server and never told the agent about it. Across two weeks of unrelated work: **24 unprompted spawns in 5 sessions, 0 times I named the tool.** It started reaching for it on repo digs, then red-team reviews, then design side quests — off prompts as light as *"be creative"* or *"in parallel."*

That's the test that matters. Can a fresh agent discover and choose this tool without coaching?

**2. The head-to-head eval.** Same model, same task, same 14-point rubric, scored across 7 categories.

> Build *Wake*: a tiny local CLI for resuming agent work after the terminal dies.

- Baseline (one agent, no Terrarium): **11/14**
- Treatment (one agent, used Terrarium once for read-only design, then implemented): **14/14**

n=1. Same model in both runs. The treatment won on three categories — CLI usability, verification, and fresh-agent resumability — because the Terrarium child returned the load-bearing design idea (a `wake resume` command that finds the run by an active/last pointer, not by remembering an id). The baseline agent shipped a working CLI but missed that the user has to *find* their old run before resuming.

Side effects of running the eval:

- Surfaced a real product bug: long-running MCP child calls need `background: true`, then polling. Already fixed.
- Treatment parent context stayed cleaner (design dig happened in the child, not inline).

The full receipt — commands, rubric, transcripts, the artifacts both runs produced — was used to ship and iterate; happy to share it on request.

## Try it

```sh
npm install -g .
terra --dry-run "summarize this repo"
```

You'll see the exact child command and prompt. Drop `--dry-run` to execute.

## When to use it

- Repo archaeology ("find every place we handle X")
- Failing test diagnosis (read-only, propose, don't edit)
- Design side quests (read 8 files, return a plan)
- Log digging where 90% of bytes are noise
- Risky experiments in `--isolation copy`

## When not to use it

- Tasks under ~5 minutes — child spin-up isn't worth it
- Anything conversational with the user — runs are batch, not chat
- Anything where verifying the child summary costs as much as just doing it
- Memory, continuity, or handoffs — out of scope, pair it with whatever you use for that

## Common recipes

**Use a different child agent.** Default is `opencode run`.

```sh
terra --agent "pi run" "fix the failing build"
TERRARIUM_AGENT="opencode run" terra "add tests for the parser"
```

**Isolate the workspace.** By default the child writes in `--cwd`. For parallel write-capable side quests, give each child its own:

```sh
terra --isolation copy "patch a disposable repo copy"
terra --isolation worktree "patch an isolated git branch"
terra --isolation copy --keep-workspace "leave the workspace for inspection"
```

Modes:

- `none` — child writes in `--cwd`.
- `copy` — copies `--cwd` into `~/.terrarium/workspaces/<runId>-<name>`. Universal fallback; works on dirty or non-Git directories.
- `worktree` — creates a Git worktree on branch `terrarium/<runId>`. Cleanest merge story for Git repos.

If the workspace is a Git checkout and the child leaves a diff, Terrarium writes a patch receipt at `~/.terrarium/runs/<runId>.patch`.

Workspace isolation is not security sandboxing. It stops parallel agents from stomping on the same checkout; it does not make arbitrary commands safe.

## Reference

```sh
terra "task"
terra --agent "opencode run" "task"
terra --cwd /path/to/repo "task"
terra --timeout-ms 600000 "task"
terra --max-depth 3 "task"
terra --isolation copy "task"
terra --dry-run "task"
terra --json "task"
terra --log ./run.log "task"
terra status
terra read <runId>
terra --help
terrarium-mcp
```

Options:

- `--agent <cmd>` — child command. Default: `$TERRARIUM_AGENT` or `opencode run`.
- `--cwd <path>` — child working directory. Default: current directory.
- `--timeout-ms <n>` — kill child after `n` milliseconds. Default: config or none.
- `--max-depth <n>` — maximum Terrarium depth. Default: config or `3`.
- `--isolation <mode>` — `none`, `copy`, or `worktree`. Default: `none`.
- `--keep-workspace` — do not delete an isolated workspace after the run.
- `--dry-run` — print the child invocation without running it.
- `--json` — print a structured result for agents.
- `--log <path>` — write the transcript to a specific file.

Config at `~/.terrarium/config.json`:

```json
{
  "defaultAgent": "opencode run",
  "maxDepth": 3,
  "timeoutMs": 900000
}
```

MCP tools:

```json
{
  "name": "terrarium_spawn",
  "arguments": {
    "task": "inspect this repo and summarize the test command",
    "agent": "opencode run",
    "cwd": "/path/to/repo",
    "timeoutMs": 600000,
    "background": true
  }
}
```

- `terrarium_spawn` — run one child agent. Pass `background: true` for anything that may take more than ~60s, then poll. Holding an MCP call open will time out.
- `terrarium_status` — list recent runs, or status of a single `runId`.
- `terrarium_read` — tail of a run log by `runId` or `logPath`.

## How it works

Terrarium is intentionally one level deep per local process. The top agent delegates messy work to one child process, preserving parent context.

Children inherit the parent environment and, for OpenCode, the same `~/.config/opencode/opencode.jsonc` MCP configuration. Terrarium sets `TERRARIUM_RUN_ID`, `TERRARIUM_DEPTH`, and `TERRARIUM_MAX_DEPTH` so composed children can inherit tools without recursing forever.

Need more depth? The child can start its own Terrarium:

```text
terra task A
  child runs: terra task B
    grandchild does B
```

Each process still owns only one child. The system composes; no single process fans out.

## Why not just shell?

You can. Terrarium is for when the parent agent needs its context window to stay pristine across long-running sub-tasks. One fresh process, clean handoff, no pollution. Depth guard stops infinite recursion. That's it.

A terrarium is a tiny sealed world. This one grows subagents without letting them overrun the room.
