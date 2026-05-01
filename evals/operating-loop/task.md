# Operating loop eval

Goal: prove the local agent loop works after Wake became a standalone repo.

Claim under test:

```text
disposable sessions, durable work, branchable context
```

Scenario:

1. A parent session starts a work thread and records it in Wake.
2. The parent uses Terrarium for one bounded side quest.
3. A fresh child agent resumes from Wake with no chat transcript.
4. The child uses the repo files and sidequest evidence to make one useful patch.
5. The child records its result in Wake.

Success criteria:

- Fresh agent can identify the objective from Wake, not chat history.
- Fresh agent preserves Wake/Terrarium boundary.
- Fresh agent uses Terrarium evidence instead of redoing everything.
- Fresh agent ships a useful artifact.
- Wake handoff after the eval is enough for another agent to continue.
