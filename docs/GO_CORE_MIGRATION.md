# Go core migration — target shape

Status: **planning skeleton** (shard 4). This document records the agreed target
component split for moving Terrarium's durable-execution kernel from TypeScript to
a Go core. It is descriptive of intent, not a deploy plan; no runtime is migrated
by this document. It must stay consistent with the stable contract in
[CORE_PRODUCT_DECISION.md](./CORE_PRODUCT_DECISION.md) and the current runtime in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Why a Go core

The kernel that owns durable run state, child-process supervision, and terminal
correlation benefits from a single statically-typed, easily-distributed binary:
strong process-group control, predictable concurrency, and one shippable artifact
for CI/headless hosts. The agent-facing transport, presentation, and edge surfaces
stay where they already work best — TypeScript and the Cloudflare Worker.

## Component split

The migration draws one boundary: the durable execution **kernel** moves to Go;
the **adapters** and the **edge wake transport** remain TypeScript.

### Go core owns

- **Receipts** — run/task result correlation, terminal-result persistence, and the
  authoritative success proof chain (child exit 0 + verified `TERRARIUM_RESULT`).
- **Process supervision** — one child per run, Unix process-group launch and
  teardown, cancellation intent, deadlines, and the pure transition core
  (`run-machine` semantics) plus its supervisor loop.
- **Batch** — explicit fan-out into independent ordinary runs, durable groups, and
  the `all` / `allSettled` / `race` / `any` / `quorum` join + bounded-concurrency
  semantics.
- **Sweeps** — background reconciliation: orphan/stale-run detection, retention and
  pruning of journaled callbacks and metadata, and inflight-claim recovery.

### TypeScript adapters remain TypeScript

- CLI, Node API, and MCP server surfaces (`src/cli.js`, `src/mcp.js`, `src/secure-mcp.js`).
- The Pi host-delivery extension (subscribe → claim terminal events → inject
  follow-up → ack).
- Runner/agent invocation shims and workspace (copy/worktree/secure) glue.

These adapters call the Go core over a stable boundary and translate to/from each
host's idioms. They do not re-implement kernel state.

### Worker Pulse remains TypeScript

The edge wake transport ([PULSE.md](./PULSE.md)) — the control worker, the
`PulseRouter` Durable Object, and its SQLite journal/mailbox tables — stays a
TypeScript Cloudflare Worker. The Go core emits terminal events to Pulse; Pulse
owns durable at-the-edge fan-out across closes, sessions, and machines.
The Go core does not run inside the Worker.

## Boundary diagram

```text
  TypeScript adapters                 Go core (kernel)              Worker Pulse (TS)
  CLI / Node / MCP / Pi ext           receipts                      control worker
        │                             process supervision           PulseRouter DO
        │  spawn/status/read/cancel   batch + groups                SQLite journal
        ├────────────────────────────►  sweeps                      mailboxes
        │                                  │                              ▲
        │                                  │  emit terminal event         │
        │                                  └──────────────────────────────┘
```

## Invariants preserved across the migration

- One ordinary run owns one child process and at most one terminal result plus one
  deterministic terminal callback event.
- Exit 0 alone is never success; the run/task-correlated receipt is authoritative.
- `terrarium_spawn`, `terrarium_status`, and `terrarium_read` stay the stable base
  interface; batch composes ordinary runs rather than adding a second execution path.
- Lineage-scoped capability policy (no sibling visibility; minimal/max-depth-one
  runs have no recursive spawn) is enforced by the Go core.

## Non-goals

- This shard does not move any runtime, change deploy, or add a Go build.
- The Go core does not absorb the adapters or the Worker; the split above is the
  whole boundary.
- No new product surface (memory, role registry, workflow DSL) is introduced; the
  non-goals in [CORE_PRODUCT_DECISION.md](./CORE_PRODUCT_DECISION.md) still hold.

## Shard 1 — implemented skeleton

The first migration shard lands a minimal, **inert** Go core seed alongside the
TypeScript runtime. Nothing is deployed and the TS adapters remain the production
path; the existing `run-machine` semantics are now mirrored in Go so future shards
can move supervision behind a stable, ported transition core.

- `go.mod` — module `github.com/cloudflare/terrarium`, Go 1.26 (shared with the
  pre-existing `go/runner` package).
- `internal/run` — pure transition core, a faithful port of
  [`src/run-machine.js`](../src/run-machine.js). Same `MachineVersion`, terminal
  classification (`done`/`failed`/`cancelled`/`error`/`inconclusive`), cancel/
  deadline precedence, receipt-deferred finalization, and late-input idempotence.
  No clocks, processes, files, or I/O.
- `internal/protocol` — JSON command protocol envelope (`Command`/`Response`) for
  the inert commands `dry-run`, `status`, `version`, and `replay`, plus stdin/stdout
  `Decode`/`Encode`.
- `cmd/terra-core` — CLI entrypoint. Flag mode (`terra-core dry-run "task"`,
  `status <runId>`, `version`) and a `--stdin` JSON-protocol mode. All commands are
  inert: no spawning, no deployment, no state mutation.

Run the Go tests with `go test ./internal/... ./cmd/...`. The transition core is
kept in lockstep with `RUN_MACHINE_VERSION`; any change to the TS machine must be
mirrored here and vice versa.

### Cross-language conformance — the `replay` command

Shard A proved the cores agree at the *initial-state* level (machine version,
initial phase/receipt). It could not catch a divergence in how the two cores
*classify a terminated run*, which is exactly where the cancelled/deadlined
"verified receipt survives as verified" lie was reproduced in the Go port.

The Go core now exposes a fourth inert command, `replay`, that drives an ordered
sequence of already-observed inputs through `internal/run.Transition` and returns
the final state plus the per-step decision list:

```sh
echo '{"command":"replay","requireReceipt":true,"inputs":[
  {"type":"ReceiptObserved","status":"verified","summary":"win"},
  {"type":"CancelRequested"},
  {"type":"ChildExited","exitCode":0}
]}' | terra-core --stdin
```

The `inputs` shape mirrors the input objects accepted by `transition()` in
[`src/run-machine.js`](../src/run-machine.js) (`ChildExited`, `ReceiptObserved`,
`CancelRequested`, `DeadlineReached`, `ProcessTerminated`, `RuntimeError`), so the
*identical* sequence can drive both cores. `replay` stays inert: no clocks,
processes, files, or state mutation — it is the pure machine, scripted.

The conformance net is `test/go-vs-ts-replay-conformance-shard-p.test.js`. It
feeds a battery of sequences (every receipt classification, the
receipt-before-exit and receipt-before-cancel/deadline races, late-input
idempotence, runtime error) to both the TS `transition()` core and the Go core's
`replay`, then asserts byte-for-byte parity on the consumer-facing terminal
fields (`status`, `ok`, `exitCode`, `taskContractStatus`, `taskResultSummary`,
`reason`). The Go comparison skips cleanly when no `go` toolchain is available
(or set `TERRARIUM_GO_CORE` to a prebuilt binary); the TS-only sequence
assertions always run. A future change that drifts the Go terminal
classification away from TS now fails conformance instead of shipping silently.
