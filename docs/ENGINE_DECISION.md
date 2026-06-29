# Engine decision — TypeScript is the engine

Decision date: 2026-06-29.

Terrarium's production engine is TypeScript.

The Go code in this repository is not a user-facing alternate engine and must not be documented as something operators enable with an environment flag. Terrarium should not ask users to choose between engines.

## Why

The stable product contract is the boring one:

```text
one bounded task → one child process → one correlated receipt
```

That contract is currently implemented, tested, and operated through the TypeScript runtime and adapters. The Go code is useful as an internal conformance target for pure run-machine/replay semantics, but it does not own production process supervision, callback routing, groups, doctor repair, MCP behavior, or Pi delivery.

Shipping an opt-in Go engine flag would create two runtime stories while only one is operationally proven. That weakens Terrarium's receipt/truth posture.

## Consequences

- `terra plan` is served by the TypeScript runtime.
- `terra --version --json` reports the TypeScript engine.
- Public/operator docs must not recommend `TERRARIUM_GO_CORE`.
- Go code may remain as internal research/conformance code only if it is not presented as an operator feature.
- A future Go engine must replace the TypeScript engine as the normal path with receipts/tests/docs, not hide behind a feature flag.
