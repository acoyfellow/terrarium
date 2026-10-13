# Use your team's Terrarium

Terrarium runs agent tasks in the cloud and hands back a receipt for each one. Your team already runs it. You sign in with your normal Cloudflare login, and your runs are visible only to you.

You can paste this page into your coding agent and tell it to follow along.

## Setup (about 2 minutes)

You need Node 22+, Pi, and the Terrarium URL from your team.

```sh
brew install cloudflared
git clone https://github.com/acoyfellow/terrarium ~/terrarium
cd ~/terrarium/effect && npm ci && cd .. && npm install -g .
terra login https://terrarium.<your-team-domain>
```

`terra login` opens your browser. Sign in and approve. It then:

- prints who you are (`Signed in as you@example.com`)
- adds the Terrarium tools to `~/.pi/agent/mcp.json`
- links the callback extension into `~/.pi/agent/extensions/terrarium`

**Reload Pi.** You're done.

## Try it

Ask your agent:

> Use terrarium_spawn to run "Reply with exactly: hello".

You get back `"status": "done"` and `"provenance": "this-run"`.

For a background run, ask for `background: true`. When the run finishes, a "Terrarium run … finished" message shows up in your Pi session. There's nothing to poll.

## Good to know

- **Who can see your runs:** only you. Runs, logs and loops belong to your email.
- **Your login lasts about a day.** When tools fail with `unauthorized`, run `terra login` again.
- **Runs can't see your laptop or the internet.** A task knows only what you put in the task text.
- **"Verified" proves the result came from your task, not that it's correct.** Check answers that matter.
- **Check who you are:** `terra whoami`.

## If something's off

| What you see | Fix |
|---|---|
| `unauthorized` or HTTP 401 | Run `terra login` again. |
| The login page never opens | Copy the URL that `cloudflared` printed into your browser. |
| No "finished" message for a background run | Reload Pi. Check `terrarium_status` for the run. |
| `terra: command not found` | Rerun `npm install -g .` in `~/terrarium`. |
