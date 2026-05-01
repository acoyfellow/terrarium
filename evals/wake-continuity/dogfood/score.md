# Wake Dogfood Score

Task: improve Terrarium README using the Wake continuity eval result, while recording the work with Wake.

Score each 0–2.

| Criterion | Score | Evidence |
|---|---:|---|
| Preserved enough context | 2 | HANDOFF includes objective, decisions, files, commands, next step. |
| Fresh agent could resume | 2 | HANDOFF names exact changed file and next product decision. |
| CLI friction low | 1 | start/note/handoff worked, but WAKE_HOME was not applied consistently in shell assignment; handoff went to ~/.wake. |
| Avoided original terminal/session dependency | 2 | HANDOFF copied to dogfood/HANDOFF.md; run also stored under ~/.wake. |
| Produced useful artifact | 2 | README now has Proof: Wake continuity eval section. |

Total: 9/10

Verdict: Wake is useful enough to keep testing, and the dogfood found one UX hazard: shell-scoped WAKE_HOME is easy to get wrong. Wake should make `--home` or clearer env handling available if extracted.
