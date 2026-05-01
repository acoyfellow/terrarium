# Wake Canonicalization

Status: complete

Canonical Wake now lives at:

```text
/Users/jcoeyman/cloudflare/wake
https://github.com/acoyfellow/wake
```

The copy under `evals/wake-continuity/runs/with-terrarium/wake` is historical eval evidence.

Terrarium sidequest run:

```text
ter_20260501094151243_9zyx4u
```

## Decision

Keep the Terrarium-assisted Wake implementation as canonical:

```text
evals/wake-continuity/runs/with-terrarium/wake
```

Do not carry both implementations forward. The baseline stays only as eval evidence.

## Why this one wins

The baseline Python version is smaller and pleasant, but it does not fully solve the headline problem: resuming after terminal/session loss without remembering the run id.

The Terrarium-assisted Node version does:

- `wake resume` resolves a run from `--id`, `$WAKE_RUN_ID`, `active`, `last`, or newest run dir.
- It stores `run.json`, append-only `journal.ndjson`, and generated `HANDOFF.md`.
- It has `active` / `last` pointers so tomorrow's agent does not need to remember the session id.
- It tolerates a malformed trailing journal line.
- It guards against starting a second active run on top of the first.
- It has stronger tests: lifecycle + simulated session loss + WAKE_HOME isolation + active-run guard.

The sidequest also ran both test suites:

```text
no-terrarium: python3 -m unittest test_wake.py -v → 1 test OK
with-terrarium: node --test test/wake.test.js → 3 tests OK
```

## Changes made to canonical Wake

Pulled the useful parts of the Python prototype into the Node version:

1. **Readable run IDs**

Old shape:

```text
wake_20260501_090109_f966ef
```

New shape:

```text
wake_20260501_094518_agent-mcp-smoke_1bbf
```

This is easier to grep, read, and hand to another agent.

2. **`wake handoff --print`**

Agents can now close a run and receive the full handoff text in one command.

3. **Wake MCP server**

Added:

```text
src/mcp.js
wake-mcp
```

Tools:

- `wake_resume` — get the current or most recent handoff; this is the tool an agent should call first.
- `wake_note` — append a structured note without shell syntax.
- `wake_handoff` — close a run and return the handoff path/text.
- `wake_status` — structured status.

This is the agent-experience feature: the interface teaches itself through tool names and descriptions, without relying on skills or system prompts.

## Next 2 features for agent experience

### 1. Keep: `wake mcp` / `wake-mcp`

This is implemented as `src/mcp.js` and package bin `wake-mcp`.

Why it matters:

An agent does not need to read a skill. It can discover `wake_resume` in the MCP tool list and call it first when resuming work.

### 2. Next: `wake snapshot`

Not implemented yet.

Purpose:

Before handoff, capture cheap local context automatically:

- git changed files
- recent commits since run start
- maybe latest command exits if recorded

This reduces reliance on the agent remembering to call `wake_note --kind file` for every changed path. It should remain explicit and local-only: no daemon, no shell hook, no ambient transcript scraping.

## Verification

```sh
cd evals/wake-continuity/runs/with-terrarium/wake
npm test
```

Result:

```text
# tests 3
# pass 3
# fail 0
```

MCP smoke:

```sh
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n' | node src/mcp.js
```

Returned tools include `wake_resume`, `wake_note`, `wake_handoff`, `wake_status`.

## Stop condition met

- Best Wake chosen.
- Proof recorded.
- Canonical version evolved.
- Two agent-experience features identified.
- First feature (`wake-mcp`) implemented.
- Second feature (`wake snapshot`) scoped as next.
