# Svelte + Hono migration loop

North star: replace the clunky hand-rolled frontend with a proper component frontend and clear Worker route shape, without changing Terrarium product semantics.

Stop condition: local site builds/smokes with Svelte routes for home/docs/runs/changelog, the Worker route plan is explicit, and an adversarial review has ZERO OBJECTIONS on clunkiness, mobile basics, and migration safety.

Ground truth:
- Current site is hand-rolled in `app/src/main.js` and `app/src/style.css`.
- User says page-to-page flow is clunky and wants a Svelte + Hono shape.
- Terrarium product truth must not change: website is presentation, not authoritative proof.
- No deploy unless explicitly asked.

Build scope:
- Frontend app architecture under `app/src`.
- Package/build config dependencies needed for Svelte/Hono.
- Keep existing public assets and campaign/changelog fetches.
- Avoid touching Terrarium core runtime, CLI/MCP behavior, Pulse semantics, or public receipt data.

Loop protocol:
1. Build round: migrate to Svelte component routes first. Hono route shape may be scaffolded only if it does not destabilize current Worker routing.
2. Parent verifies with `npm run demo:build`, `npm run demo:smoke`, and local route checks.
3. Adversarial review round judges page-to-page flow, mobile/responsive basics, route safety, and product truth.
4. Fix exact objections until reviewer returns ZERO OBJECTIONS.

Safety:
- No deploy.
- No public push unless explicitly asked.
- Do not let this become a redesign vortex.
- Do not rewrite Pulse/control-worker semantics during the frontend migration.
