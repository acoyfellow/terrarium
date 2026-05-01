# Terrarium

```text
        ______________________________
       /                              \
      /  ~  ~  ~  ~  ~  ~  ~  ~  ~    \
     |                                  |
     |        ><(((º>                   |
     |                         <º)))><  |
     |                                  |
     |                  o               |
     |              o                   |
     |          o                       |
     |                                  |
     |       ___              ___       |
     |      /___\            /___\      |
     |       | |              | |       |
     |    ___|_|______________|_|___    |
     |___/__________________________\___|
```

A tiny local agent harness for one job: **orchestrate one task by spawning one subagent**.

That is the whole architecture. No fan-out. No unbounded recursion. The top-level
agent keeps its context clean by delegating work to a child. If a workflow needs
another shell, the child may start its own Terrarium run. Each process is only
one level deep, but the system composes into long-running work.

## Why

Big agent runs die by context erosion. Terrarium treats context like a root plant:
keep the top alive, push messy work into smaller pots, report back.

## Proof: Wake continuity eval

We tested Terrarium against the same model and harness on a concrete task: build **Wake**, a tiny CLI for durable agent-run continuity after terminal/session loss.

- Baseline: one agent built Wake directly.
- Treatment: one agent used Terrarium once for a read-only design side quest, then implemented from the child summary.
- Result: baseline scored **11/14**; treatment scored **14/14**.

The concrete difference: the Terrarium child found the key continuity primitive — `wake resume` with `active` / `last` pointers — so tomorrow's agent can resume without remembering the terminal, session id, or run path.

The eval also found and fixed a real Terrarium product bug: long-running MCP child calls need `background: true`, then polling via `terrarium_status` / `terrarium_read`.

See `evals/wake-continuity/RESULT.md` for the full receipt.

## Tutorial: run your first delegation

Install locally:

```sh
npm install -g .
```

Run one task through one child agent:

```sh
terra --dry-run "summarize this repo"
```

You will see the exact child command and prompt. Remove `--dry-run` to execute it.

## How-to guides

### Use a different child agent

Default child command is `opencode run`. Override it per run:

```sh
terra --agent "pi run" "fix the failing build"
```

Or set it for your shell:

```sh
TERRARIUM_AGENT="opencode run" terra "add tests for the parser"
```

## Reference

```sh
terra "task"
terra --agent "opencode run" "task"
terra --cwd /path/to/repo "task"
terra --timeout-ms 600000 "task"
terra --max-depth 3 "task"
terra --dry-run "task"
terra --json "task"
terra --log ./run.log "task"
terra status
terra read <runId>
terra --help
terrarium-mcp
```

Options:

- `--agent <cmd>`: child command. Default: `$TERRARIUM_AGENT` or `opencode run`.
- `--cwd <path>`: child working directory. Default: current directory.
- `--timeout-ms <n>`: kill child after `n` milliseconds. Default: config or no timeout.
- `--max-depth <n>`: maximum Terrarium shell depth. Default: config or `3`.
- `--dry-run`: print the child invocation without running it.
- `--json`: print a structured result for agents.
- `--log <path>`: write the transcript to a specific file.
- `--help`: show CLI help.

Config lives at `~/.terrarium/config.json`:

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
    "cwd": "/Users/jcoeyman/cloudflare/terrarium",
    "timeoutMs": 600000,
    "maxDepth": 3
  }
}
```

Also available:

- `terrarium_status`: list recent runs and metadata.
- `terrarium_read`: read the tail of a run log by `runId` or `logPath`.

For long-running MCP child tasks, call `terrarium_spawn` with `background: true`. It returns immediately with `runId`, `pid`, and `logPath`; poll with `terrarium_status` or `terrarium_read` instead of holding the MCP call open.

## Explanation

Terrarium is intentionally one level deep per local process. The top agent delegates messy work to one child process, preserving parent context. If the child needs another shell, it can start its own Terrarium process; each process still owns only one child.

Child processes inherit the parent environment and, for OpenCode, the same `~/.config/opencode/opencode.jsonc` MCP configuration. Terrarium sets `TERRARIUM_RUN_ID`, `TERRARIUM_DEPTH`, and `TERRARIUM_MAX_DEPTH` so composed children can inherit tools without recursing forever.

## Contract

1. The orchestrator accepts one task.
2. It starts at most one child agent for that task.
3. The child receives the same constraint.
4. Logs are written to `~/.terrarium/runs/` unless `--log` is passed.
5. Version stays `0.0.1`.

## Mental model

```text
top context ──spawns──> child context
   stays                 does messy work
   clean                 returns concise result
```

Need more depth? Compose it:

```text
terra task A
  child runs: terra task B
    grandchild does B
```

No single Terrarium process manages more than one child.

## Name

A terrarium is a tiny sealed world. This one grows subagents without letting them
overrun the room.

## Why not just shell?

you can. terrarium is for when the parent agent needs its context window to stay pristine across long-running sub-tasks. one fresh process, clean handoff, no pollution. depth guard stops infinite recursion. that’s it.
