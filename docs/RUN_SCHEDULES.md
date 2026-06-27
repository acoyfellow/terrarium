# Replayable run schedules

Terrarium's background supervisor feeds observed process, receipt, cancellation, and deadline facts into a pure transition function:

```text
transition(runState, observedInput) -> { state, decisions }
```

Production still owns clocks, child processes, files, metadata, and callback delivery. The transition function owns only terminal classification and the rule that one run can produce at most one terminal result and one paired completion callback.

## Replay a fixture

```sh
terra schedule replay fixtures/run-schedules/cancel-before-completion.v1.json
```

A fixture is bounded to 64 classification-only inputs. Prompts, output, tokens, environment variables, and arbitrary runtime payloads are rejected. A replay proves transition behavior for the supplied ordered inputs; it does not prove that a real process or model will reproduce those inputs.

Version 1 fixtures contain:

- the affected Git revision;
- bounded initial state (`requireReceipt` only);
- ordered observed inputs;
- allowlisted invariants;
- an optional expected terminal status.

The initial fixtures freeze both sides of cancellation versus completion:

- cancellation observed before terminal commit wins;
- cancellation observed after terminal commit is ignored.

A run terminated by cancellation or deadline produced no trusted completion, so its `taskContractStatus` is forced to `not-applicable` even when a `verified` receipt arrived before the kill. This matches the orphan terminal convention and prevents a cancelled/deadlined run from being reconstructed as a verified task success by group roll-ups, the Pi extension, or the mcp retry classifier. The same normalization is applied by the dead-supervisor cancel-recovery paths in `core.js` (`reconcileRun` and `cancelRun`).

The feature began as a bounded spike and earned retention by finding a real launch-handoff cancellation defect: cancelling immediately after detached spawn could kill the supervisor before it had a child PID, leaving the run orphaned with no terminal callback. The supervisor now remains alive, observes the durable cancel marker, terminates the child, and emits exactly one terminal callback.
