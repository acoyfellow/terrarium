# Terrarium

![A glass terrarium on a desk. Inside, a small robot tends a garden of smaller robots, each in its own pot.](./assets/social-card.jpg)

Hand a task to an agent in the cloud. Get back the answer and a receipt that shows it came from your task.

## What it looks like

You ask your coding agent:

> Use terrarium_spawn to run "Reply with exactly: hello".

You get back:

```json
{
  "ok": true,
  "runId": "ter_mv2qdrha_9f5a3a434d2a",
  "status": "done",
  "taskContractStatus": "verified"
}
```

That's a real run. It happened on Cloudflare, not your laptop.

Ask for `background: true` and you can keep working. When the run finishes, the result shows up in your session on its own.

## Try it

**If your team already runs Terrarium**, setup takes about two minutes. Follow [Use your team's Terrarium](./docs/USE-A-SHARED-INSTANCE.md). In short:

```sh
git clone https://github.com/acoyfellow/terrarium ~/terrarium
cd ~/terrarium && npm ci && npm install -g .
terra login https://terrarium.<your-team-domain>
```

Sign in with your normal Cloudflare login, reload Pi, and you're done.

**If you want your own instance**, deploy it to your Cloudflare account: [Deploy your own](./docs/REFERENCE.md#deploy-your-own).

**If you just want to try it on your laptop**, no cloud needed:

```sh
terra --agent "pi -p --no-session" "summarize README.md"
terra status <runId>
```

## What you can check

Every run hands back three values: a run ID, a fingerprint of the task, and a one-time number the server made up when it accepted the task. The agent has to echo all three back. If any of them is missing or wrong, the run doesn't count as done, however confident the agent sounds.

| You want to know | Look at |
|---|---|
| Did it actually finish? | `status: done` and `taskContractStatus: verified` |
| Which task produced this answer? | The run ID and task fingerprint |
| What did it say? | `terra read <runId>`, or the logs endpoint |
| Is anyone else seeing my runs? | No. Runs, logs and results belong to your login. |

## What it doesn't do

- **It doesn't check that the answer is right.** "Verified" means the answer came from your task. Check answers that matter.
- **Cloud runs can't see your files.** A cloud task knows only what you put in the task text.
- **A local run is not a sandbox.** It runs as you, with your files and keys. For untrusted code, use the opt-in [Docker profile](./docs/SECURE_V1.md).

## Tools

| Tool | What it does |
|---|---|
| `terrarium_spawn` | Run one task. Add `background: true` to get the result later. |
| `terrarium_spawn_batch` | Run several tasks at once. |
| `terrarium_status` | See how a run is doing. |
| `terrarium_read` | Read a run's log. |
| `terrarium_cancel` | Stop a run. |

The CLI does the same: `terra "task"`, `terra batch`, `terra status`, `terra read`, `terra cancel`, `terra login`, `terra whoami`.

## More

- [Reference](./docs/REFERENCE.md): every guarantee, flag, API route and limit, in full.
- [Use your team's Terrarium](./docs/USE-A-SHARED-INSTANCE.md): the two-minute setup.
- [Threat model](./THREAT_MODEL.md) and [architecture](./docs/ARCHITECTURE.md).
- [Changelog](./CHANGELOG.md).
