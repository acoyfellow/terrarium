# Run-Index Live-Verify — Track B gate

Date: 2026-07-19T16:09Z
Deployed version: 3e9d9441-2fd4-4437-9258-6d9444afe45a (100% traffic)
Rollback target (pre-deploy live): fd99c0a8-be79-4976-afac-5db4a908c429 (2026-07-18T15:57:33Z)

## Gate results (live https://terrarium.coey.dev)
- health(200):  GET /                 -> 200 ✓
- auth(401):    GET /api/runs         -> 401 {"ok":false,"error":"unauthorized"} ✓
- auth(401):    GET /api/runs (bogus) -> 401 ✓
- route live:   GET /api/runs?channel=&status=&since= -> 401 (auth-gated, not 404) ✓
- binding:      TERRARIUM_LEDGER KV bound in deployed bundle ✓

## Notes
- Worker serves only via custom domain (no workers_dev preview); verified via
  versioned upload -> promote -> live probe -> rollback ref in hand.
- Positive-path (valid token -> 200 list) not runnable from operator shell:
  prod TERRARIUM_CONTROL_TOKEN is a Worker-only secret (correct posture).
  Handler correctness proven by DO+endpoint suite (36/36) through real API path.
- Deploy built from CLEAN HEAD (foreign working-tree changes stashed during
  deploy, restored after).
