# Use a shared Terrarium instance

Your team runs one Terrarium instance behind Cloudflare Access. You sign in with your normal Cloudflare login. You don't copy any tokens, and your runs and results are visible only to you.

This page is written so a coding agent can follow it for you.

## What you need

- Node 22 or newer
- `cloudflared` (`brew install cloudflared`)
- The instance URL from your team, for example `https://terrarium.<your-team-domain>`
- Membership in the Access policy that protects that URL

## 1. Install Terrarium

```sh
git clone https://github.com/acoyfellow/terrarium
cd terrarium && npm ci && npm install -g .
```

## 2. Sign in

```sh
terra login https://terrarium.<your-team-domain>
```

A browser window opens on the Cloudflare Access login page. Approve it. The command prints who you are signed in as, for example:

```text
Signed in to https://terrarium.<your-team-domain> as you@example.com (owner user:you:example.com)
```

This stores the instance URL and turns on login-based access in `~/.terrarium/config.json`. Your session is held by `cloudflared` on your machine, and it never reaches the cloud cell where tasks run.

Check it at any time:

```sh
terra whoami
```

When the session expires, run `terra login` again.

## 3. Connect your agent

Add the Terrarium MCP server to your agent. For Pi, add this to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "terrarium": {
      "command": "node",
      "args": ["<path-to-terrarium>/src/mcp.js"],
      "env": {
        "TERRARIUM_URL": "https://terrarium.<your-team-domain>",
        "TERRARIUM_ACCESS_LOGIN": "1"
      }
    }
  }
}
```

Reload the agent. `terrarium_spawn` now runs tasks on the shared instance as you, and returns a verified receipt.

## What is scoped to you

| Thing | Who can see it |
|---|---|
| Runs you start | Only you |
| Logs and receipts of your runs | Only you |
| Completion callbacks for your runs | Only you |
| Your run budget (concurrency, per-minute, per-day) | Counted for you alone |

Your identity is the email in the Access login, checked on every request against Cloudflare's signature. Someone else on the team can't read your runs or receive your callbacks, even with their own valid login.

## Machines and CI

Something that can't open a browser, such as CI, uses an Access service token and a bearer token issued by the instance owner. Ask the owner for those. People should always use `terra login`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `whoami failed: HTTP 401` | Run `terra login` again; the session expired. |
| A Cloudflare "nothing here" page in tool output | The agent is running old code or an old URL. Reload the agent. |
| Login opens no browser | Copy the URL that `terra login` printed into your browser. |
