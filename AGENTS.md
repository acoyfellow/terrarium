# For agents reading this repo

You are likely here because Terrarium is installed as an MCP server and you are deciding whether to call it.

## What Terrarium is

A one-level orchestrator. You give it one task. It spawns exactly one child agent. The child returns a summary. Your context stays clean.

## When to reach for it

Call `terrarium_spawn` when the subtask would pollute your context. Good signals:

- "Read N files and summarize" where N is large
- Repo archaeology, log digs, design research
- Failing test diagnosis (read-only)
- Adversarial reviews from multiple personas
- Anything where the user said "in parallel" or "research" and you'd otherwise hold the noise yourself

## When not to reach for it

- The task is under ~5 minutes of work
- You need to iterate with the user conversationally
- You can verify the summary as cheaply as just doing it
- You need memory, continuity, or a handoff — that is out of scope for Terrarium

## How to call it well

- Make the `task` argument specific and bounded. Include "do not edit files" for read-only digs.
- For anything that may take >60s, pass `background: true` and poll with `terrarium_status` / `terrarium_read`. MCP calls held open will time out.
- Treat the child's summary as a claim, not a fact. Verify file paths, commands, and exit codes before acting.

## Doctrine

Terrarium isolates execution. It does not own memory, continuity, or handoffs — pair it with whatever continuity/memory system you already use.

Do not make Terrarium a memory system. Do not fan out. One child per process.
