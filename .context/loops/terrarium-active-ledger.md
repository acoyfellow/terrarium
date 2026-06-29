# Terrarium active-ledger smoothness loop

North star: Pi spinner and Terrarium status agree with reality. A stale supervisor-only or dead-child run must not keep `activeCount` or the Pi extension active.

Ground truth:
- User observed Pi spinner active when nothing should be active.
- `terrarium_status` reported 15 active runs.
- Audit found most were stale `running` records with dead child PIDs and old logs; one was a two-day live/hung child and was cancelled.
- After reconciliation/cancel, global `terrarium_status` reports `activeCount: 0`.

Build scope:
- Terrarium core active-run reconciliation.
- Pi Terrarium extension spinner reconciliation.
- Tests/docs/receipts for this bug.

Loop protocol:
- Patch minimal production code.
- Verify with targeted tests and real `terrarium_status`/`doctor`.
- Add regression test for supervisor-only stale runs.
- Stop only when status says zero active, Pi extension prunes stale ids, and tests cover the bug.

Safety:
- No unrelated product deploy.
- Do not cancel active runs unless audited as stale/hung or user-approved.
