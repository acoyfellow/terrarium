# Bug report — 2026-07-21 — cloud child fails contract as `mismatch:runId`

Surfaced by the new `terrarium_report_failure` pipeline, which filed this from two
real cloud runs (`ter_mruqi7ag_4c8120dba74c`, `ter_mruqiwpj_8280ea582383`).

## Symptom
Every cloud child this session terminates `failed` / `taskContractStatus: missing` /
exit `6`, with the runner log line:

```
[terrarium:runner] receipt did not match contract (mismatch:runId)
```

The children do the actual work correctly (the requested specs are complete and
good in the log), but the run is marked failed.

## This is the honesty contract working, not a false failure
`scripts/terrarium-runner` requires the agent's final line to be exactly one
`TERRARIUM_RESULT={...}` receipt whose `runId` / `taskFingerprint` / `nonce` match the
contract the backend assigned. A zero-exit process with a missing or mismatched
receipt is classified **inconclusive/failed**, never a task win — that is the whole
point of the contract. So "failed" here is correct: Terrarium cannot trust the
result, so it does not.

## Root cause (blame: agent/model)
The fixed cloud child model (`terrarium/workers-ai`, a small Workers AI model, per
`scripts/terrarium-runner.config.json`) does not reliably echo the assigned `runId`
verbatim into its receipt line. The runner injects the exact expected shape into the
agent message:

```
Your final line MUST be exactly one JSON receipt of the shape
TERRARIUM_RESULT={"runId":"<RUN_ID>","taskFingerprint":"<FP>","nonce":"<N>","summary":"..."}
```

but a small model, after emitting a long structured spec, frequently (a) invents its
own runId, (b) drops/renames the field, or (c) emits no marker. The runner correctly
refuses to synthesize a receipt on the model's behalf, so the run fails closed with
exit 6 (`mismatch:*`) / 4 (absent) / 7 (malformed).

## Separate issue observed same session — callbacks
Cloud terminal callbacks were also not waking the session. That has its own bug
report (`BUGREPORT-2026-07-21-batch-opaque-error-and-cloud-callbacks-silent.md`, three
layers: `ownerId` stripped server-side, `pi-*` wildcard guard, token not resolved from
disk) and was fixed + deployed. This report is only about the receipt mismatch.

## Options to fix the receipt mismatch (not yet done)
1. **Runner-side receipt assembly from a minimal token.** Instead of asking the model
   to echo the full contract, have the agent emit only a short opaque `nonce` the
   backend already knows, and let the runner construct the full `TERRARIUM_RESULT`
   from the contract file it already holds. The nonce still proves the agent ran to
   completion; the model no longer has to reproduce a long id verbatim. (Smallest,
   highest-leverage change; keeps the security property that the agent must produce a
   secret it could only have if it actually ran.)
2. **A stronger/instruction-tuned child model** for the receipt step.
3. **A structured-output / tool-call receipt** rather than a free-text trailing line,
   so the id is machine-filled, not model-typed.

Recommendation: option 1. It removes the model's need to transcribe a long id while
preserving the nonce-based proof-of-execution.

## Detection is now automatic
`terrarium_report_failure` classifies this exact case as `receipt-mismatch`
(detail `mismatch:runId`, blame `agent`, exit 6) and dedupes repeated hits into one
report with an occurrence count — so this failure mode is now visible as a filed
artifact rather than something an operator has to notice by reading raw logs.
