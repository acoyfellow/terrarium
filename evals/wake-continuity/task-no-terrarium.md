You are building a tiny 0.0.1 repo inside an existing repository.

Create /Users/jcoeyman/cloudflare/terrarium/evals/wake-continuity/runs/no-terrarium/wake.

Goal:
Build Wake, a local CLI for durable agent-run continuity after terminal/session loss.

User problem:
I sit down tomorrow and should not need to remember which terminal, OpenCode session ID, or agent transcript mattered. I want the next agent to receive the context I wanted preserved: objective, decisions, attempts, changed files, commands, failures, and next step.

Requirements:
- Use any language you choose.
- Keep it tiny.
- Add README.md.
- Add a CLI.
- Add one real test.
- Add examples/demo-receipt.md.
- CLI should support at least: start, note, status, handoff.
- Store local state under ~/.wake/runs by default, but support WAKE_HOME env var for tests.
- Do not use Terrarium.
- Run tests.
- Return changed files and verification.
