# Terrarium engine decision loop

North star: remove ambiguity around `TERRARIUM_GO_CORE`. Terrarium must have one truthful engine story: either land Go as the normal engine or invalidate/remove the flag-facing experimental path. No docs should tell operators to use an experimental engine flag.

Ground truth:
- Production execution is TypeScript today.
- A prior evidence loop recommended keeping TypeScript for production and leaving Go as an experimental bounded core.
- User now rejects experimental feature flags as product surface.
- Docs currently mention `Use Go core where available`, which is misleading.

Build scope:
- Read existing Go-vs-TS docs/tests/adapter.
- Decide TS or Go engine based on concrete readiness.
- If TS wins: remove/hide user-facing Go-core instructions, mark Go core internal/research only or remove flag surface from docs where operators see it.
- If Go wins: make Go the normal path and prove it.

Loop protocol:
- Spawn read-only adversarial engine review.
- Parent verifies and applies the decision.
- Stop when docs/product surface have no ambiguous experimental-engine instruction and tests pass.

Safety:
- No deploy unless explicitly requested.
- No public push unless asked.
