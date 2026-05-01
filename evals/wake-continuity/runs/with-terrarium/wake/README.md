# wake

Tiny local CLI for **durable agent-run continuity** after terminal/session loss.

You sit down tomorrow. You don't remember which terminal you were in, which
OpenCode session it was, or what the last agent was about to do. Wake fixes
that: you (or your agent) leave breadcrumbs as you work, then a `wake handoff`
writes a single `HANDOFF.md` that the next agent can read first thing in the
morning to pick up exactly where you left off.

Status: **0.0.1**. Single file, zero dependencies, Node ≥ 18.

## Install

This repo is the source. To use it directly:

```sh
node bin/wake.js --help
# or, after `npm link`:
wake --help
```

## Storage

State lives under `~/.wake/` by default. Override with `$WAKE_HOME`
(used by tests and ephemeral runs).

```
~/.wake/
├── active                       # run-id of the currently open run, if any
├── last                         # run-id of the most recently handed-off run
└── runs/
    └── wake_YYYYMMDD_HHMMSS_hex/
        ├── run.json             # run header + final summary
        ├── journal.ndjson       # append-only event log (source of truth)
        └── HANDOFF.md           # generated on `wake handoff`
```

## CLI

```
wake start    --objective "<text>"
wake note     --kind <decision|attempt|command|failure|file|next|note> [opts]
wake status   [--id <run>] [--json]
wake handoff  [--id <run>] [--summary "..."] [--next "..."]
wake resume   [--id <run>]
wake list
```

### `start`
Begins a run. Writes `run.json`, sets the `active` pointer.
Errors if a run is already open.

### `note`
Append one event to the journal. Kinds:

- `decision` / `failure` / `next` / `note` — `--text "..."`
- `attempt` — `--text "..." [--ok]`
- `command` — `--cmd "..." [--exit N] [--output-tail "..."]`
- `file` — `--file <path>` (optional `--text` for context)

### `status`
Renders the current run as Markdown. `--json` dumps the structured form.

### `handoff`
Closes the run. Writes `HANDOFF.md`, moves pointer from `active` → `last`.
If you didn't pass `--next`, the most recent `kind:next` note is used.

### `resume`
Prints `HANDOFF.md` if available, otherwise renders status. Resolves a run
from (in order): `--id`, `$WAKE_RUN_ID`, `~/.wake/active`, `~/.wake/last`,
or the most-recent run directory.

## How "tomorrow morning" works

```sh
# today
wake start --objective "refactor parser"
wake note --kind decision --text "use recursive descent"
wake note --kind command --cmd "pnpm test" --exit 1
wake note --kind failure --text "lexer regression on numerics"
wake note --kind file --file src/parser/lexer.ts
wake note --kind next --text "write infix-binding-power tests"
wake handoff --summary "parser half-done"

# tomorrow, fresh terminal, no memory of anything:
wake resume
```

The fresh `wake resume` finds the run via `~/.wake/last` and prints
the HANDOFF doc — objective, decisions, attempts, failures, commands,
changed files, and the next step.

## Design choices (and what is *not* in 0.0.1)

- **Append-only NDJSON journal.** Crash-safe, partial-write tolerant
  (the reader skips a malformed trailing line), trivially `tail -f`-able.
- **One run open at a time.** Trying to `wake start` while another run
  is open errors out; close it first.
- **No daemon, no auto-capture, no shell hooks.** You (or your agent)
  type the notes. Ambient capture is a 0.1 problem.
- **No diffs / patches.** We record file paths, not contents. Git is the
  source of truth for what actually changed.
- **No edit / delete.** If you wrote a wrong note, write a correcting one.
- **No remote sync, no auth, no MCP server, no TUI.** Local CLI only.

## Tests

```sh
npm test
```

The test suite spawns the real `bin/wake.js` against a temp `WAKE_HOME`
and verifies the full lifecycle: start → notes (every kind) → handoff →
simulated session loss → `wake resume` finds the run and prints every
preserved field. It also corrupts the journal mid-write and asserts that
resume still succeeds.

## Provenance

Wake's design came from a single read-only Terrarium side quest before
implementation. See `examples/demo-receipt.md` for a real handoff produced
by Wake itself shipping its own 0.0.1.
