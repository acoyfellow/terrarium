# Terrarium

![A glass terrarium on a desk. Inside, a small robot tends a garden of smaller robots, each in its own pot.](./assets/social-card.jpg)

Hand a task to an agent in the cloud. Get back the answer and a receipt that shows it came from your task.

## What it looks like

You ask your coding agent:

> Use terrarium_spawn to run "What is 17 multiplied by 23? Reply with just the number."

You get back:

```json
{
  "runId": "ter_mv44zm3a_5723d13c1abb",
  "status": "done",
  "provenance": "this-run",
  "summary": "391"
}
```

Give a proof to check the work. Terrarium runs it in the box after the agent finishes:

> Use terrarium_spawn to run "Create add.js exporting add(a,b)" with proof `node -e "process.exit(require('./add.js').add(2,3)===5?0:1)"`

```json
{
  "runId": "ter_…",
  "status": "done",
  "provenance": "this-run",
  "proof": { "command": "node -e \"process.exit(require('./add.js').add(2,3)===5?0:1)\"", "exitCode": 0, "output": "" }
}
```

That's a real run. It happened in a Cloudflare container with no internet, not on your laptop.

Ask for `background: true` and keep working. When the run finishes, the result shows up in your Pi session on its own.

## Try it

You need Node 22+, Pi, `cloudflared`, and your team's Terrarium URL.

```sh
brew install cloudflared
git clone https://github.com/acoyfellow/terrarium ~/terrarium
cd ~/terrarium/effect && npm ci && cd .. && npm install -g .
terra login https://terrarium.<your-team-domain>
```

Sign in with your normal Cloudflare login, reload Pi, and you're done. The full steps are in [Use your team's Terrarium](./docs/USE-A-SHARED-INSTANCE.md).

## What you can check

Every run gets three values from the server: a run ID, a fingerprint of the task, and a one-time code. The agent must print all three back on one receipt line. If any is missing or wrong, the run does not get provenance `this-run`, however confident the agent sounds.

| You want to know | Look at |
|---|---|
| Did it finish? | `status: done` (receipt from this run, and proof exit 0 if you gave one) |
| Which task produced this answer? | The run ID and task fingerprint |
| What did it say? | `terrarium_read`, or `GET /api/runs/<id>/logs` |
| Can anyone else see my runs? | No. Runs, logs and loops belong to your login. |

## What it doesn't do

- **Provenance alone doesn't check the answer.** It means the answer came from your task. Give a proof to check the work. A proof only checks what it tests.
- **Runs can't see your files.** The box starts empty with only the task text. The agent can write files inside the box, and they are deleted when the run ends.
- **Runs can't reach the internet.** The container's only route is to the model.

## Tools

| Tool | What it does |
|---|---|
| `terrarium_spawn` | Run one task. Add `background: true` to get the result later. |
| `terrarium_status` | See how a run is doing. |
| `terrarium_read` | Read a run's log. |
| `terrarium_cancel` | Stop a run. |
| `terrarium_list` | List your runs, newest first. |
| `terrarium_loop_start` | Retry a task until its proof exits 0 and/or its answer contains what you expect. |
| `terrarium_loop_status` | See one loop or all of them. Also on the `/loops` page. |

The CLI: `terra login <url>`, `terra whoami`, `terra mcp`.

## More

- [How it works](./docs/ARCHITECTURE.md): the parts, the path of one run, and why it's built this way.
- [Reference](./docs/REFERENCE.md): API routes, limits, deploy steps.
- [Use your team's Terrarium](./docs/USE-A-SHARED-INSTANCE.md): the two-minute setup.
- When to use something else: see the Compare page on the site (`/compare`).
- [Rollback](./docs/ROLLBACK.md) and [threat model](./THREAT_MODEL.md).
