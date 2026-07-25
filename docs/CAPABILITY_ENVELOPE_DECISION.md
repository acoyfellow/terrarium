# Capability envelope decision

Status: draft decision — build-library first, then integrate into core receipts.

## Decision

Build the capability-envelope drift scorer as a small library/harness first, not as immediate hard enforcement in Terrarium core.

Decision value:

```text
build-library
```

## Why

The drift lab shows that naming allowed reads/writes/commands can improve behavior on a synthetic fixture, and the hardened scorer can produce a reconstructable receipt. But enforcement and observation are not complete yet:

- shell command recording exists;
- before/after write hashing exists;
- trusted policy tamper detection exists;
- round reduction exists;
- command argv normalization now accepts basename-equivalent absolute paths;
- shell reads are derived from common read commands in the command log;
- Pi/internal tool reads are not yet captured;
- command recording only works when the child is launched through the harness;
- n is still too low for broad claims.

So the next safe product slice is a library/harness that emits capability-audit receipts. Core Terrarium should integrate the receipt fields only after the harness proves stable across replicated delegated runs.

`cloudbox/` should be weighed as a preferred next execution/proof substrate for stronger repo-level receipts: it already centers fresh Cloudflare computers, command/verify receipts, diffs, artifacts, and shareable proof pages. The boundary should stay clear: Cloudbox can produce stronger execution evidence, while Terrarium owns bounded task admission, capability-audit receipt semantics, and durable terminal wake events.

## Integrate later when

- replicated control/treatment receipts exist;
- at least three guardrail/capability experiments have machine-readable receipts;
- an independent stop-gate audit passes;
- tool-level read/edit capture has a clear design or is explicitly out of scope in the receipt schema.

## Latest audit correction

Read-only auditor `ter_20260701195029724_72fwgh` found the `build-library` direction sound but readiness overclaimed. Accepted fixes:

- normalize command argv before allowlist comparison so absolute shim paths such as `/usr/bin/make safe` can match `make safe`;
- derive shell-observed reads from common read commands in the trusted command log;
- add a regression test for absolute command paths and derived shell reads.

Still open:

- `receiptComplete` is only a structural completeness check, not a semantic proof;
- writes/tasks remain content-light and fixture-specific;
- replicated delegated receipts are still needed before core integration;
- a small Cloudbox-backed drift receipt adapter is a good next implementation slice if local synthetic receipts are rejected by the independent stop-gate audit.

## Rejected alternatives

| Option | Reason rejected for now |
|---|---|
| Build core enforcement immediately | Measurement trust is not complete; would overclaim security semantics |
| Keep as docs only | Drift-score north star needs runnable receipts and regression tests |
| Integrate external workflow engine | The problem is capability audit semantics, not workflow fanout |
| Collapse into Cloudbox | Cloudbox is a strong repo computer/proof substrate, but Terrarium still owns task/callback/capability-audit semantics |
| Reject entirely | Early fixture evidence shows measurable behavior change worth pursuing |
