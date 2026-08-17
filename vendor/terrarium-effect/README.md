# Terrarium Effect

This is a standalone experiment rebuilding Terrarium with Effect 4. It pins `effect` to `4.0.0-beta.107`; the beta API is checked against the installed declarations before it is used.

## Planned slices

- **Slice 0 — scaffold:** pinned toolchain, strict TypeScript, a purity gate, domain schemas, typed domain errors, deterministic fingerprints, and falsification tests.
- **Slice 1 — lifecycle:** model run creation and legal status transitions.
- **Slice 2 — execution:** define child-process requests, results, and time boundaries.
- **Slice 3 — persistence:** add durable run storage and receipt records.
- **Slice 4 — coordination:** add claims, conflict handling, and ownership transfer.
- **Slice 5 — orchestration:** compose lifecycle, execution, persistence, and coordination services.
- **Slice 6 — interface:** expose the experiment through a small CLI and end-to-end gate.

## Design boundary

Pure logic is deliberately not wrapped in Effect. Domain calculations such as `fingerprint` remain ordinary deterministic TypeScript functions. Effect is reserved for the later slices that need explicit effects, resources, failures, or services.

## Verification

Run the complete Slice 0 gate with:

```sh
npm run gate
```

The gate type-checks the project, rejects impure production TypeScript, and runs the Vitest suite. `test/falsification-slice0.test.ts` writes a deliberate source violation and verifies that `scripts/purity.mjs` rejects it.
