# terrarium-airlock spike

Drives a Terrarium release through **airlock's** `runPipeline` + **keel's** signed
proof, with **real Terrarium qual probes** as the fanout tests. It demonstrates
the "new SDLC" pattern the two repos share and kills the anti-pattern of treating
every deploy as a scary one-off manual gate.

## What it shows

```
candidate (Terrarium worker content digest)
  -> deploy slot: the live non-prod qual worker (serves no prod traffic)
  -> fanout^x REAL probes (each an observed fact, never prose):
       health-200                  GET /health == 200
       api-auth-401                unauth POST /api/runs == 401
       verified-run                a real cloud run reaches taskContractStatus=verified
       graded-artifact-reverifies  the run's graded receipt artifact re-verifies (E2)
  -> keel signs the evidence bound to the exact candidate digest (only key use)
  -> verifySignedProof admits -> promote
       qual: recorded (auto)
       prod (terrarium.coey.dev): HUMAN-GATED — recorded as PROMOTE_REQUEST, never flipped
```

Run (bun, because airlock + keel are a bun/TS workspace):

```sh
bun run experiments/terrarium-airlock/run.mjs
```

Requires: sibling `../airlock` (exports `runPipeline`, deps `keel`), a live
non-prod qual worker, and a token file. Both are supplied via env — nothing
environment-specific is baked in:

```sh
TERRA_QUAL_BASE=https://<your-qual-slot> \
TERRA_QUAL_TOKEN_FILE=/path/to/token.secret \
bun run experiments/terrarium-airlock/run.mjs
```

## Why this matters (the intersection)

airlock and Terrarium are the two halves of one loop:

| | Terrarium | airlock |
|---|---|---|
| proves | a *task* ran correctly (receipt: runId+taskFingerprint+nonce) | a *candidate version* is safe to promote (keel proof bound to digest) |
| unit | one bounded agent run | one deploy candidate |
| fanout | parallel child runs | parallel test jobs |
| gate | only a verified TERRARIUM_RESULT is success | only a keel-verified proof promotes |
| human gate | prod deploy | prod pointer-flip |

airlock's `runFanout` port already names Terrarium as a backend; Terrarium's
graded receipt artifact (`src/cloud/receipt-artifact.js`) is structurally keel —
content-addressed, signed-shaped, third-party re-verifiable, weakest-wins. This
spike composes both: airlock is the deploy instance, Terrarium is the task
instance, keel is the shared proof grammar.

## The anti-pattern it kills

Deploy stops being a heroic manual act. Candidate → non-serving slot → prove →
auto-promote is the default; the ONLY thing a human touches is the final prod
pointer-flip, which is a recorded, reversible request — not a leap of faith.
Deploying continuously is safe *because* the signed proof gates it.

## Honesty gate

- Every fanout job checks an observed fact against the live slot; a child's
  self-report is never the evidence.
- The graded-artifact job independently re-verifies the content-addressed
  receipt, so a claim that can't be re-derived from the artifact fails.
- The prod pointer-flip is never automated here (`setFeatureGate` records a
  request; it cannot flip `terrarium.coey.dev`).
- Output (RECEIPT.json, PROMOTE_REQUEST.json) is under `out/` and gitignored.
