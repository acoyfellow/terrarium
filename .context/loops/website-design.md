# Terrarium website design loop

North star: the website feels polished across home/docs/runs, especially mobile. Stop condition: mobile responsiveness and page-width consistency are fixed and verified with screenshots/build/smoke.

Ground truth:
- User called out two huge eyesores: mobile responsiveness and inconsistent widths per page.
- Current app has home, docs, runs/changelog routes in `app/src/main.js` and CSS in `app/src/style.css`.
- Public site is already deployed, but this loop fixes locally first unless deployment is explicitly requested.

Build scope:
- `app/src/main.js`
- `app/src/style.css`
- only website layout/aesthetic responsiveness; no runtime/orchestration changes.

Loop protocol:
- Audit mobile and widths.
- Patch CSS/layout.
- Verify with build/smoke and local screenshots if possible.
- Stop when home/docs/runs use consistent max-width/padding and mobile layout has no table/page overflow as the default reading surface.

Safety:
- No deploy unless explicitly requested.
