# Self-host onboarding — "Install on Cloudflare"

Goal: a fresh person lands on `terrarium.coey.dev`, clicks **Install on Cloudflare**, and ends
up with their **own** working Terrarium instance at their **own** URL — with the least friction
honestly possible. This maps every gap between today and that CTA, friendliest path first.

## The North Star CTA

Primary button, everywhere the current "Get started" lives:

> **Install on Cloudflare** → Cloudflare's official Deploy button (`deploy.workers.cloudflare.com/?url=<repo>`)

Deploy-to-Cloudflare (DtC) clones the repo into the user's own GitHub, provisions the bound
resources (KV, R2, DO, container, Workers AI) on **their** account, runs the build, and deploys.
That is the friendly path. The CLI/`wrangler deploy` path stays documented as the manual fallback.

---

## Gaps (blockers → nice-to-have)

### G1 — `wrangler.jsonc` is hardwired to the maintainer's account  🔴 BLOCKER
A fresh `wrangler deploy` fails today because the config pins maintainer-only identifiers:
- `account_id: "<your-account-id>"` — must be removed (DtC/user supplies their own).
- `kv_namespaces[].id` — two hardcoded IDs pointing at the maintainer's KV. DtC provisions new
  ones; manual users need `wrangler kv namespace create`.
- `r2_buckets[].bucket_name: "terrarium-control-artifacts"` — must be user-created / DtC-provisioned.
- `routes: [{ pattern: "terrarium.coey.dev", custom_domain: true }]` — maintainer's domain; a
  fresh deploy must NOT claim it. Remove; let the user get a `*.workers.dev` URL by default.

**Fix:** ship a clean template `wrangler.jsonc` with no `account_id`, no hardcoded resource IDs,
no custom-domain route. Keep the maintainer's real values in a private, gitignored overlay
(`wrangler.prod.jsonc` or CI-only) so `terrarium.coey.dev` still deploys.

### G2 — No `Deploy to Cloudflare` button / DtC metadata  🔴 BLOCKER
There is no button and no DtC-compatible config. DtC reads `wrangler.jsonc` bindings and
provisions them, but it needs:
- a public repo (have: `github.com/acoyfellow/terrarium`),
- bindings it can auto-create (KV/R2/DO/container/AI — all present),
- required secrets declared so DtC prompts for them at deploy time.

**Fix:** add the button to README + site, and declare required secrets (G3) so DtC prompts.

### G3 — Required secrets are undocumented at the point of deploy  🔴 BLOCKER
The worker fails **closed** (generic 401) until these are set — but nothing tells the user:
- `TERRARIUM_PRINCIPAL_ID` — REQUIRED, stable owner identity (matches `^[A-Za-z0-9._:-]{1,128}$`).
- `TERRARIUM_CONTROL_TOKEN_CURRENT` — REQUIRED, the bearer token for `/api/runs`.
- `TERRARIUM_CONTROL_TOKEN_PREVIOUS` — optional (rotation).
- `TERRARIUM_PULSE_TOKEN_CURRENT` — required only if using Pulse callbacks.

**Fix:** declare these so DtC prompts for them; document `wrangler secret put` for manual users;
add a one-liner to generate a strong token (`openssl rand -hex 32`).

### G4 — Plan/quota prerequisites are unstated  🟠 FRICTION
The stack needs a **Workers Paid** plan: Durable Objects (SQLite), Containers
(`max_instances: 20`), and R2. Workers AI has its own quota. A free-plan user will hit hard
failures with no explanation.

**Fix:** state prerequisites up front (Workers Paid, Containers enabled, R2 enabled). Consider a
lighter default (`max_instances` smaller) for first deploy; the qual config already uses `5`.

### G5 — Container build is heavy and easy to get wrong  🟠 FRICTION
`Dockerfile.pi` (`linux/amd64`) builds a Pi execution cell; local `wrangler deploy` needs a
running Docker daemon (colima). DtC builds server-side, which is actually *friendlier* — but the
manual path must say "you need Docker running."

**Fix:** document the Docker requirement for the manual path; note DtC avoids it.

### G6 — `TERRARIUM_MODE: "fixture"` is a non-issue for `/api/runs`  🟢 RESOLVED (verified)
Verified in source: `TERRARIUM_MODE` only gates the legacy campaign/policy routes
(`/policy`, `/campaigns`, `/health` label). The cloud execution path (`POST /api/runs` →
admission → container → `env.AI.run`) is **mode-independent** — it does real Workers AI
execution regardless of mode. No action needed beyond a one-line doc note that `fixture` refers
to the campaign lab, not `/api/runs`.

### G7 — No post-deploy "did it work?" smoke path  🟠 FRICTION
After deploy the user has a URL but no guided "prove it works" step.

**Fix:** a copy-paste smoke: `curl /health` (200), then an authed `POST /api/runs` with their
token → `202 { runId }`, then `GET /api/runs/:id/status`. Put it in the tutorial as step 6.

### G8 — Site messaging still blurs local CLI vs. cloud  🟡 POLISH
Partially addressed (Two-ways-to-run section). The CTA change makes the cloud path primary, so
the split must be crisp: hero button = "Install on Cloudflare" (your own edge); a secondary
"Or run locally" link = the CLI path.

---

## Proposed friendly flow (target state)

1. Land on site → **Install on Cloudflare** button.
2. DtC: authorize → repo cloned to user's GitHub → resources provisioned on their account.
3. DtC prompts for `TERRARIUM_PRINCIPAL_ID` + `TERRARIUM_CONTROL_TOKEN_CURRENT` (with a
   "generate one" hint).
4. Build + deploy → user gets `https://terrarium-control.<them>.workers.dev`.
5. Site/README smoke block: `curl /health`, then authed `POST /api/runs` → `202 { runId }`.
6. Done: their own instance, their own URL, their own data.

## Execution order

1. G1 — template `wrangler.jsonc` (unblocks everything); private overlay for prod.
2. G3 — declare + document required secrets.
3. G2 — add the button (README + site CTA).
4. G4/G5/G6 — prerequisites + mode clarity.
5. G7 — post-deploy smoke.
6. G8 — final CTA/messaging polish.
7. **E2E test**: deploy a genuinely fresh instance to a throwaway state and walk steps 1–6.
