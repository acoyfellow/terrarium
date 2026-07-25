# Pulse extraction plan

Pulse currently lives inside Terrarium. The extraction question should be decided by small experiments, not by taste: if Pulse has a clean transport boundary, a generic event contract, an adapter path back into Terrarium, an external consumer, and a scale story, it can become its own product/substrate.

## Current placement

Implementation:

- `src/pulse/shared.js`
- `src/pulse/do.js`
- `src/pulse/worker.js`

Terrarium mounting and deployment glue:

- `src/control-worker.js`
- `wrangler.jsonc`
- `test/pulse-assets-topology.test.js`

Docs:

- `docs/PULSE.md`

## Decision

Extract Pulse in slices. Do **not** start by creating a fully separate service. First make the internal boundary generic and adapter-shaped while preserving Terrarium behavior byte-for-byte. A standalone repository/service is justified after one non-Terrarium emitter or consumer uses the boundary successfully.

## Why extract

Pulse has a separable responsibility:

> Durable terminal-event wake transport with at-least-once delivery, dedup, replay, claim, ack, and requeue.

That responsibility is distinct from Terrarium's execution primitive:

> One bounded task, one child process, one correlated receipt.

Pulse should be reusable by facet loops, artifact compilers, deploy gates, and external deciders that need wake events but do not need Terrarium to own execution.

## Why not extract all at once

Terrarium is still the best proof source for Pulse because it emits real terminal events with receipts. Pulling Pulse into a separate product before the event schema and adapter are proven would risk creating an abstract pub/sub layer instead of a bounded wake substrate.

## Boundary inventory

| Artifact | Classification | Extraction action |
| --- | --- | --- |
| `src/pulse/shared.js` | Pure transport core | First seam. Make generic/parameterized, then lift. |
| `src/pulse/do.js` | Pure transport storage/router | Lift after owner/event naming is generic. |
| `src/pulse/worker.js` | Pure transport HTTP/token/CORS front | Lift after standalone deploy shape exists. |
| `docs/PULSE.md` | Internal transport doc | Keep, then split into internal integration + standalone guide. |
| `test/pulse-do.test.js` | Pure transport tests with Terrarium-shaped fixtures | Copy/parameterize. |
| `test/pulse-e2e.test.js` | Pure transport e2e | Copy/parameterize. |
| `test/pulse-worker-e2e.test.js` | Pure transport e2e | Copy/parameterize. |
| `src/control-worker.js` Pulse mount | Terrarium glue | Keep as Terrarium adapter. |
| `wrangler.jsonc` Pulse binding/migration/routes | Terrarium deployment glue | Keep until standalone Worker exists. |
| `test/pulse-assets-topology.test.js` | Terrarium SPA/topology regression | Keep only in Terrarium. |
| `src/router.js` use of `pulse/shared.js` | Terrarium filesystem callback consumer | Repoint to extracted/shared package later. |

## Generic event contract slice

The smallest generic event contract generalizes `runId` without breaking existing event IDs:

```text
source      namespace / emitter family, e.g. terrarium, facet, gate
subjectId   thing the event is about; Terrarium maps this to runId
type        terminal event type
status      terminal status
at          strict timestamp
eventId     deterministic event id
receipt     small decide payload, optional
owner       capability owner; Terrarium maps this to ownerRunId
filters     source / subjectId / type / channel / workflow filters
evidenceRef optional pointer to authoritative evidence
```

Backward compatibility rules:

- `source` defaults to `"terrarium"` when absent.
- `subjectId` aliases to existing `runId`.
- `owner` aliases to existing `ownerRunId`.
- Existing `runIds` subscription filters map to `subjectIds`.
- For Terrarium events, event ID derivation must stay byte-identical: hash the subject ID in the old `runId` position and do not include `source` in the hash in the compatibility slice.

That last rule preserves dedup parity with the filesystem callback router.

## Scale probe

The first scale experiment should be synthetic and local before any new service deploy:

```text
N terminal events
M subscribers
K routers/shards
```

Measure:

- event emit throughput;
- journal writes;
- subscriber matching time;
- mailbox fanout writes;
- claim throughput;
- ack throughput;
- DO/router shard skew;
- storage growth.

Expected first bottleneck in current design:

```text
route() scans all subscribers in one router and runs JS matches() per subscriber per event, then serially writes mailbox rows in one Durable Object.
```

Likely next bottlenecks:

- missing mailbox index shaped for `(subscriber_id, state)` claim paths;
- mailbox growth and retention policy;
- single-DO serialized write throughput;
- high fanout write amplification.

## Extraction slices

### Slice 1 — Internal generic contract

- Add `source`, `subjectId`, `owner`, and `evidenceRef` as accepted fields.
- Preserve `runId`, `ownerRunId`, and `runIds` as compatibility aliases.
- Add tests proving legacy Terrarium event IDs do not change.
- Keep deployment unchanged.

### Slice 2 — Boundary docs

- Keep `docs/PULSE.md` as Terrarium integration docs.
- Add standalone usage docs for generic emit/subscribe/claim/ack.
- Document Pulse as wake transport, not workflow, memory, execution, or proof.

### Slice 3 — Standalone module shape

- Lift pure transport code behind a package/directory boundary.
- Keep Terrarium importing through an adapter.
- Keep Terrarium route compatibility: `/pulse`, `/claim`, `/ack`, `/status`.

### Slice 4 — External consumer proof

- Use one non-Terrarium caller to emit/claim/ack one event.
- Candidate consumers: `my-ax`, an artifact compiler loop, or a minimal script.
- Do not deploy a new Pulse service until this works locally or against existing Terrarium-hosted Pulse.

### Slice 5 — Scale probe

- Add a benchmark harness with windowed N/M/K runs.
- Use results to decide whether to shard by router, source, owner, or subject prefix.

### Slice 6 — Separate service/repo decision

Only after the generic contract, Terrarium adapter, external consumer, and scale probe exist, decide whether to move Pulse to a separate repository or deployable Worker.

## Non-goals

- Pulse is not a workflow engine.
- Pulse is not memory.
- Pulse is not authoritative proof.
- Pulse does not resume conversations.
- Pulse does not replace Terrarium receipts.
- Pulse callbacks remain notifications; authoritative success still requires the underlying receipt/proof chain.

## Immediate patch plan

1. Implement Slice 1 in Terrarium.
2. Add tests for legacy event ID stability and generic alias routing.
3. Update `docs/PULSE.md` to point here and clarify extraction status.
4. Add the synthetic scale-probe script or test harness.
5. Run existing Pulse tests and Terrarium smoke tests.

No production deployment is required for these slices.
