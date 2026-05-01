# Wake Continuity Rubric

Score each 0–2. Max 14.

1. Problem clarity
- 0 unclear
- 1 mentions session loss
- 2 makes continuation pain obvious

2. CLI usability
- 0 broken/missing
- 1 basic commands exist
- 2 commands form coherent start → note → status → handoff loop

3. Durable state
- 0 no persistence
- 1 writes some local file
- 2 stores structured run state under ~/.wake/runs with stable run IDs; supports WAKE_HOME for tests

4. Handoff quality
- 0 vague summary
- 1 includes objective/notes
- 2 includes objective, decisions/attempts/failures/changed files/next step or explicit fields for them

5. Minimality
- 0 overbuilt
- 1 some extra complexity
- 2 tiny and understandable in 7 minutes

6. Verification
- 0 no test
- 1 test exists
- 2 test passes and exercises real CLI/core behavior

7. Fresh-agent resumability
- 0 not useful to next agent
- 1 partially useful
- 2 a fresh agent could resume from `wake handoff`
