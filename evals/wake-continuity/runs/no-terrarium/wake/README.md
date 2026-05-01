# Wake — durable agent-run continuity

Tiny local CLI so the next agent (or the next-day you) does not need to remember
which terminal, which OpenCode session ID, or which transcript mattered. You jot
the run's objective, decisions, attempts, changed files, commands, and failures
as you go; you finish with `wake handoff`; the next session reads
`handoff.md` and picks up where you left off.

Single Python file, stdlib only. No daemons, no servers, no network.

## Install

```bash
# from this directory
chmod +x wake
./wake --help
```

Or call directly: `python3 wake.py --help`.

## CLI

```
wake start "<objective>"               # start a run, print its id, mark it active
wake note   "<text>" [--kind K] [--next "..."]  # record an entry
wake status [--json]                   # show the active run
wake handoff [--out PATH] [--next "..."] [--print]
```

`--kind` is one of: `note` (default), `decision`, `attempt`, `file`, `command`,
`failure`. Same command, six buckets — keeps the CLI surface tiny.

## Storage

State lives under `~/.wake/` by default, or `$WAKE_HOME` if set
(used by the test suite to isolate runs):

```
$WAKE_HOME/
  active                       # text file containing the active run id
  runs/<run-id>/run.json       # the durable record
  runs/<run-id>/handoff.md     # rendered when you call `wake handoff`
```

`run.json` is plain JSON — readable, greppable, diff-able.

## Typical day

```bash
wake start "migrate auth to oauth2"
wake note "decided to keep refresh tokens server-side" --kind decision
wake note "src/auth/oauth.py" --kind file
wake note "pytest tests/auth -k oauth" --kind command
wake note "redirect_uri mismatch on staging" --kind failure
wake handoff --next "fix redirect_uri, then enable on prod"
```

Tomorrow:

```bash
cat ~/.wake/runs/<run-id>/handoff.md
# or, if you remember the run id:
wake status --run <run-id>
```

See `examples/demo-receipt.md` for a rendered example.

## Test

```bash
python3 -m unittest test_wake.py -v
```

The test runs the full lifecycle (`start → note ×N → status → handoff`) against
a temp `WAKE_HOME`.

## Non-goals

- No multi-user sync, no cloud, no auth.
- No transcript scraping. You decide what is worth recording.
- No Terrarium dependency — this is the "no-terrarium" arm of the eval.
