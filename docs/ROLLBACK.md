# Rolling back to the old Terrarium

Effect 4 Terrarium replaced the old JavaScript service on 2026-10-11. The last commit with the old code is `04c2f68`.

## Service

1. Check out `04c2f68` in a separate worktree.
2. Move the shared hostname back. Copy the `routes` block from `effect/wrangler.ax.local.jsonc` into the old `wrangler.ax.local.jsonc`, then deploy with `npx wrangler deploy -c wrangler.ax.local.jsonc`.
3. Remove the shared hostname from `effect/wrangler.ax.local.jsonc` and redeploy the Effect Worker. The Effect Worker keeps its own hostname.

Runs made on one version do not show up on the other. Each Worker has its own Durable Objects.

## Laptop

1. Restore the Pi MCP config from `~/.terrarium/backups/mcp.json.bak-<timestamp>` to `~/.pi/agent/mcp.json`.
2. Point `~/.pi/agent/extensions/terrarium` back at `pi-extension` in the `04c2f68` checkout. The old target is saved in `~/.terrarium/backups/ext-terrarium-target.bak-<timestamp>`.
3. Run `/reload` in each Pi session.

## Check

Run `terrarium_spawn` with background set to true from Pi, and wait for the completion follow-up.
