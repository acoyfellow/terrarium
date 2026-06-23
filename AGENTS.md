# For agents reading this repo

You are likely here because Terrarium is installed as an MCP server and you are deciding whether to call it.

## What Terrarium is

At its stable core, Terrarium is a durable execution and callback layer. One ordinary run receives one bounded task, owns one child process, and produces one correlated receipt. Your context stays clean while status, logs, cancellation, and callbacks remain inspectable outside the parent agent.

For explicit top-level parallel work, `terrarium_spawn_batch` accepts an array of jobs and creates independent ordinary runs under one durable group. It does not change the one-child-per-run contract. The public containment laboratory is frozen maintenance-only provenance; do not extend it unless the product decision changes.

## When to reach for it

Call `terrarium_spawn` when the subtask would pollute your context. Good signals:

- "Read N files and summarize" where N is large
- Repo archaeology, log digs, design research
- Failing test diagnosis (read-only)
- Adversarial reviews from multiple personas
- Anything where the user said "in parallel" or "research" and you'd otherwise hold the noise yourself; use `terrarium_spawn_batch` when one explicit array call is clearer than repeated independent spawns

## When not to reach for it

- The task is under ~5 minutes of work
- You need to iterate with the user conversationally
- You can verify the summary as cheaply as just doing it
- You need conversation memory, session continuation, or interactive handoff; Terrarium persists run results/callbacks but does not resume an agent conversation

## How to call it well

- Make the `task` argument specific and bounded. Include "do not edit files" for read-only digs.
- Use `model` when a child must be pinned. For an ephemeral Pi child, use `agent: "pi -p --no-session"`; configure `readOnlyAgent` separately when read-only work should use Pi or another runner.
- For anything that may take >60s, pass `background: true` and poll with `terrarium_status` / `terrarium_read`. MCP calls held open will time out.
- Treat the child's summary as a claim, not a fact. Verify file paths, commands, and exit codes before acting.
- MCP children must return Terrarium's run/task receipt. A zero exit with a missing or mismatched receipt is `inconclusive`, not success.
- Minimal and max-depth-one children do not receive recursive spawn authority and cannot inspect sibling runs. Do the delegated task directly instead of querying Terrarium orchestration state.

## Containment honesty

- `--isolation copy` and `--isolation worktree` prevent checkout collisions; they are not security sandboxes.
- Current ordinary children inherit host authority and environment. Do not use the ordinary path for hostile agents or real-secret red teaming.
- In containment-related code, treat attacker output as a claim until a separate trusted detector/verifier reproduces it.
- Never give an attacker child GitHub write, merge, release, or genuine secret-bearing credentials.

Read `THREAT_MODEL.md` and `docs/AUTONOMOUS_LOOP.md` before adding containment or public automation features.

## Doctrine

Terrarium isolates execution for ordinary delegation. It does not own memory, continuity, or handoffs — pair it with whatever continuity/memory system you already use.

Do not make Terrarium a memory system or general workflow DSL. Preserve `terrarium_spawn`, `terrarium_status`, and `terrarium_read` as the stable base interface. Keep one child and receipt per run. Explicit batch fan-out must compose ordinary runs, durable groups, cancellation, and callbacks rather than inventing a second execution path. Runner/model selection remains part of the bounded spawn contract.
