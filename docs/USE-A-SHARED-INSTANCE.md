# Use your team's Terrarium

Terrarium runs agent tasks in the cloud and hands back a verified receipt for each one. Your team already runs it. You sign in with your normal Cloudflare login, and your runs are visible only to you.

You can paste this page into your coding agent and tell it to follow along.

## Setup (about 2 minutes)

You need Node 22+, Pi, and the Terrarium URL from your team.

```sh
brew install cloudflared
git clone https://github.com/acoyfellow/terrarium ~/terrarium
cd ~/terrarium && npm ci && npm install -g .
terra login https://terrarium.<your-team-domain>
```

`terra login` opens your browser. Sign in and approve. It then:

- prints who you are (`Signed in ... as you@example.com`)
- connects Pi: it adds the Terrarium tools to `~/.pi/agent/mcp.json` and installs the callback extension

**Reload Pi.** You're done.

## Try it

Ask your agent:

> Use terrarium_spawn to run "Reply with exactly: hello" in the cloud.

You get back `"status": "done"` and `"taskContractStatus": "verified"`.

For a background run, ask it to spawn with `background: true`. When the run finishes, the result shows up in your Pi session as a "Terrarium completion event". There's nothing to poll.

## Good to know

- **Who can see your runs:** only you. Runs, logs, receipts and completion events belong to your email.
- **Your session lasts about a day.** When tools start failing with `unauthorized`, run `terra login` again.
- **Cloud runs can't see your laptop.** A cloud task only knows what you put in the task text. To work on local files, run Terrarium locally.
- **"Verified" proves the result came from your task, not that it's correct.** Check answers that matter.
- **Check who you are:** `terra whoami`.

## If something's off

| What you see | Fix |
|---|---|
| `unauthorized` or HTTP 401 | Run `terra login` again. |
| A Cloudflare "nothing here" page in tool output | Reload Pi. |
| The login page never opens | Copy the URL that `terra login` printed into your browser. |
| Background runs finish but no completion event arrives | Run `terra login` again, then reload Pi. |
| `terra: command not found` | Rerun `npm install -g .` in `~/terrarium`. |
