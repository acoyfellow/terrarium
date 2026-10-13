# For agents reading this repo

You are probably here because Terrarium is installed as an MCP server and you are deciding whether to call it.

## What Terrarium is

A way to get work off the laptop. Each run gets a fresh Cloudflare container with an empty `/workspace`, a Pi agent with read, write, edit and bash, and no internet. The only route out is the model, through the Worker, so the box holds no keys.

A run can carry a `proof`: a shell command Terrarium runs in `/workspace` after the agent finishes. A run is `done` only when the receipt came from this run and the proof exited 0. Without a proof, `done` means only "this run answered".

## When to call it

- Work you want to leave the laptop: it keeps going if the laptop sleeps, and the result comes back into your session.
- Self-contained tasks you can describe fully in the task text, with a proof that checks the result.
- Several independent tasks at once, each with its own box.

## When not to call it

- The task needs your files, your repo, or the internet. The box starts empty and can't download anything.
- The task is quicker to do than to describe.
- You need a conversation; each run is one task.

## How to call it well

- Put everything the agent needs in `task`. It sees nothing else.
- Give a `proof` whenever the result can be checked by a command. Without one, a confident wrong answer still finishes `done`.
- Use `background: true` for anything longer than a minute. The result arrives in your Pi session when it's done.
- For a goal that may need retries, use `terrarium_loop_start` with a `proof`. The loop stops only on proof exit 0 or when attempts run out.
- Treat the summary as a claim. `provenance: this-run` says which run answered, not that it is right. The proof is the check.

## Boundaries

- The box can't reach the internet: outside sites get 403. `node effect/scripts/egress-check.mjs` proves it live and writes `effect/receipts/egress.json`.
- No secrets are in the box. The same check lists secret-looking environment names, and there are none.
- Runs, logs and loops belong to the signed-in owner. Another owner gets 404.
- Containers are isolated by Cloudflare's container runtime. Terrarium adds no isolation claim of its own beyond the network block. See `THREAT_MODEL.md`.

## Code

The service is in `effect/src` (Effect 4 TypeScript). Tests are in `effect/test`. `npm run gate:effect` runs the typecheck, lint, tests, mutation check and the live receipts. Do not add source-code comments; the pre-commit hook rejects them.
