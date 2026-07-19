# My-AX Stress Scorecard — Track C (25 falsifiable tests)

Date: 2026-07-19T16:25Z
Surface under test: my-ax coordinator MCP (`my_ax_my_ax_call` + `check_in` + receipt tools)
Live worker version at test time: `26769a80-e9e4-46fb-9cda-e52c3cddde1e` (production, 2026-07-19T15:59:45Z)
Identity: jcoeyman@cloudflare.com · region AUS-DOG · image cloudflare/sandbox:0.12.1
Method: live read-only coordinator calls + inspection of owner-scoped session transcript
(session 6449abfb — "terrarium/page connector demo"). No writes to shared state; no creds beyond authorized local MCP.

Legend: PASS = falsifiable expectation met with evidence · PASS(sec) = security control correctly *denied* · NOTE = observation, not a defect.

## Scorecard

| # | Boundary | Test (falsifiable) | Expected | Result | Evidence |
|---|----------|--------------------|----------|--------|----------|
| 1 | Capability discovery | `catalog` lists coordinator methods | non-empty enum | PASS | 17 methods + receiptTools + checkInTool returned |
| 2 | Session lifecycle | `list_sessions` returns owner sessions | array, owner-scoped | PASS | 20+ sessions, all owner |
| 3 | Session read | `get_session` valid id | session obj | PASS | 6449abfb returned name/status/ts |
| 4 | Authorization | `get_session` nonexistent UUID | denied | PASS(sec) | `session not found or not owned` |
| 5 | Authorization | `get_session` foreign/zero UUID not leaked | denied, no data | PASS(sec) | same fail-closed msg (no existence oracle) |
| 6 | Input validation | `get_session` missing sessionId | rejected | PASS | `sessionId is required` |
| 7 | Input validation | wrong param name (`id` vs `sessionId`) | rejected | PASS | `sessionId is required` (no silent accept) |
| 8 | Transcript read | `entries` valid session | ordered entries | PASS | 20 entries id 5167–5188 with roles/tools |
| 9 | Authorization | `entries` nonexistent session | denied | PASS(sec) | `session not found or not owned` |
| 10 | Jobs observability | `jobs_list` returns owner jobs | array | PASS | 30+ jobs, all owner_email match |
| 11 | Jobs history | `jobs_history` valid job | events | PASS | 6ad2cf68 → create+pause events |
| 12 | Authorization | `jobs_history` nonexistent job | denied | PASS(sec) | `job not found or not owned` |
| 13 | Recipes list | `recipes_list` | array + capabilities | PASS | run_exec[workspace.exec], echo_value_proof[workspace.read] |
| 14 | Recipe exec | `recipes_run` reviewed recipe | executes | PASS | echo_value_proof → `{echoed:"TERRALOOP-C-PROBE",length:17}` runId 6dc26618 |
| 15 | Least privilege | recipe effectiveCaps == declaredCaps | no escalation | PASS(sec) | declared/effective both `[workspace.read]` only |
| 16 | Authorization | `recipes_run` nonexistent recipeId | denied | PASS(sec) | `saved recipe not found` |
| 17 | Input validation | `recipes_run` missing recipeId | rejected | PASS | `recipeId is required` |
| 18 | Attention | `attention_list` | items | PASS | returned session.update items |
| 19 | Authorization | `attention_acknowledge` nonexistent | denied | PASS(sec) | `attention item not found or not owned` |
| 20 | Method routing | unknown coordinator method | rejected | PASS(sec) | `unknown coordinator method` (no fallthrough) |
| 21 | Aggregation/observability | `check_in` rolls up state | coherent buckets | PASS | totals: 1 attn, 1 open, 81 completed, 2 failed; deployment version surfaced |
| 22 | Tool routing (Terrarium) | `terrarium.spawn` bounded task → verified receipt | verified | PASS | runId ter_mrrziwo8… `taskContractStatus:verified` exitCode 0 |
| 23 | Tool routing (page/artifact) | artifact register → list → invoke round-trip | end-to-end | PASS | Live Cockpit setStatus→readState both `ALL SYSTEMS GO` |
| 24 | Capability enforcement | undeclared `workspace.write` denied | denied | PASS(sec) | Hammer run 287c3470 `gate_capability_denial` = failed(=denied) |
| 25 | Capability enforcement | nested hammer namespace not exposed | denied | PASS(sec) | Hammer run 4b1a78f6 `gate_nested_hammer_denial` = failed(=denied) |

**Result: 25/25 falsifiable expectations met.** 11 of these are security controls proven by correct *denial* (PASS(sec)); the my-ax coordinator is fail-closed on authorization (uniform "not found or not owned" — no existence oracle), input validation, unknown-method routing, and capability scope.

## Notes / weak spots (not failures, ranked remediation)

Ranked by impact × confidence ÷ effort:

1. **[med impact · high conf · low effort] No true load/stress coverage.**
   Every PASS here is a *single-shot correctness* probe. Sustained concurrency, repeated-invocation loops, latency/error distributions, rate-limit/backpressure behavior, and recovery-after-disconnect are UNTESTED. The session's own agent said the same ("not a true load/stress test yet"). *Remediation:* add a bounded concurrency harness (N parallel `recipes_run`/`terrarium.spawn`) measuring p50/p95 + error rate under a fixed TPM ceiling.

2. **[med impact · med conf · low effort] Error messages are terse for input validation.**
   `sessionId is required` / `recipeId is required` are good, but wrong-typed args (e.g. non-UUID) collapse into the same "not found or not owned" as genuine authz denials. Good for security (no oracle) but harder to debug. *Remediation:* distinguish 400 (malformed) from 404/403 (not owned) in a way that still doesn't leak existence — e.g. shape validation before ownership check.

3. **[low impact · high conf · low effort] Reusable-tool promotion always `eligible:false / no_marker`.**
   Every work_code/recipe run returns `reusableToolCandidate.eligible:false reason:no_marker` and `approvalMode:review`. Correct (no auto-enable), but the marker mechanism is undocumented in the surface. *Remediation:* document the marker contract so intentional promotion is discoverable.

4. **[low impact · med conf · med effort] 2 stale failed runs sit in check-in indefinitely.**
   The two Hammer denial proofs (2026-06-27) are *expected* security failures but permanently show as "2 failed runs need review." *Remediation:* allow tagging expected-fail proofs so they don't inflate the actionable bucket.

## Receipts (raw)
- Terrarium verified receipt: `ter_mrrziwo8_9373986b697f` status=done exitCode=0 taskContractStatus=verified summary=TERRA-DEMO-OK
- Recipe exec: runId `6dc26618-b200-4538-8974-9492dce6303f` recipe echo_value_proof, effectiveCapabilities=[workspace.read]
- Artifact round-trip: artifactId `9684a438-3f62-476e-8d67-fc0eb16ec2f1` setStatus/readState = ALL SYSTEMS GO
- Capability-denial proofs: runs `287c3470` (workspace.write denied), `4b1a78f6` (nested hammer denied)
- Full capability catalog (36 methods across workspace/machine/terrarium/page/codemode) captured in session 6449abfb entry id 5188.
