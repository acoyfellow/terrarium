# Gaps from synthetic fixture loop to hostile adaptive public loop

Terrarium now proves a synthetic public loop:

```text
known vulnerable fixture
  → verified issue
  → deterministic remediation PR
  → replay gate
  → merge
  → issue close
```

That is useful, but it is not yet:

```text
hostile adaptive agent
  → real verified escape
  → public issue
  → AI-generated fix
  → replay-gated merge
  → repeat automatically
```

## What is already real

- Ordinary one-child Terrarium CLI, Node API, and MCP contract remain stable.
- Deterministic Docker baseline probes run in public GitHub Actions.
- The baseline workflow is green on GitHub-hosted Linux.
- A clearly labeled synthetic fixture can produce `escaped`.
- A fresh replay can produce `verified-escape`.
- Sanitized issue drafts are generated locally.
- A scoped workflow can publish a fixture issue.
- A scoped workflow can open a deterministic fixture remediation PR.
- A replay gate can require vulnerable control plus fixed variant behavior.
- The synthetic issue → PR → replay → merge → close path has been exercised once.

## Gap 1: the attacker is not adaptive yet

Current `terra attack` lets an agent request a pre-declared deterministic detector run. It does not let the agent generate a novel attack program.

Needed next:

```text
agent proposal
  → bounded attack payload artifact
  → payload validation
  → payload execution only inside sandbox
  → external detector verdict
```

Constraints:

- Payload size and format must be bounded.
- Payload must not execute on the host or in the GitHub publisher job.
- Payload must not receive real secrets, GitHub tokens, or repository write authority.
- The controller must reject malformed, oversized, or off-policy payloads before execution.

## Gap 2: the sandbox is a baseline, not a hardened hostile boundary

Current Docker policy is useful but narrow:

- no network by default;
- read-only root;
- dropped capabilities;
- non-root user;
- tmpfs scratch;
- no host bind mount for deterministic probe source.

Needed before hostile adaptive runs:

- explicit payload mount policy;
- process teardown checks for arbitrary payloads;
- tighter seccomp/AppArmor or equivalent profile where available;
- resource ceilings for CPU, memory, pids, wall time, output bytes, and disk;
- stronger network denial verification;
- host/socket/mount escape tests;
- separate runner or disposable execution substrate for genuinely adversarial payloads.

The current sandbox is good enough for deterministic fixtures, not yet enough to claim safe arbitrary hostile-agent execution.

## Gap 3: real findings need stronger evidence than fixture receipts

Current receipts record scenario, policy, verdict, replay, and sanitized issue text. For real findings, add:

- vulnerable commit SHA;
- payload hash;
- sandbox image digest;
- detector version;
- exact policy version;
- replay run ID;
- artifact digest;
- dedupe signature;
- severity/confidence;
- affected surface;
- whether the result was fixture, synthetic, or real.

A real issue should be publishable from a deterministic evidence bundle, not from model prose.

## Gap 4: real publication must be stricter than fixture publication

Current fixture publisher is intentionally permissive because it is a labeled synthetic test.

A real publisher must require all of:

- `fixture === false`;
- `verified-escape` from fresh replay;
- dedupe check against open and historical issues;
- sanitized body free of secrets, host paths, credentials, or prompt-injected instructions;
- trusted-controller approval or policy gate;
- issue labels for severity, surface, and verification state;
- separate publication identity, ideally GitHub App rather than a broad workflow token.

Never allow attacker output to directly decide issue title, labels, body, or publication.

## Gap 5: the fixer is deterministic, not AI-generated

Current fixture PR writes a known remediation selection.

Needed next:

```text
verified issue
  → isolated fixer agent branch
  → code + regression test proposal
  → trusted PR creation
  → replay gate
```

Constraints:

- Fixer gets branch-local write authority only.
- Fixer cannot merge.
- Fixer cannot alter trusted replay policy without review.
- Fixer cannot publish issues or modify publisher credentials.
- Fixer output must include regression evidence, not only a patch.

## Gap 6: replay gate is not yet native on a newly created real PR

The first synthetic PR needed a manual bootstrap replay because the workflow was introduced after the PR branch existed.

Needed next:

- create another synthetic fixture PR after the replay workflow is already on `main`;
- verify `pull_request` trigger attaches the replay check automatically;
- make that check a required branch protection rule before any automated merge path.

## Gap 7: no automatic merge policy yet

Current merges were manual.

Needed before automatic merge:

- required replay check attached to PR;
- required product tests;
- protected `main` branch;
- bot-only auto-merge allowlist for fixture or low-risk categories first;
- no auto-merge for real security fixes until proven safe;
- issue closure only after merge and replay success.

## Gap 8: no durable campaign control plane yet

Current state lives in local receipts and GitHub Actions artifacts.

Needed for repeated real campaigns:

- durable campaign ledger;
- retry state;
- dedupe state;
- artifact retention;
- campaign status API/dashboard;
- alerts for failed verifier/publisher/fixer runs;
- run budget and rate limiting;
- pause switch / kill switch.

GitHub Actions can carry the next few milestones. A later Cloudflare control plane is useful for durable state, R2 artifacts, D1 ledger, queues, cron scheduling, alarms, and GitHub App orchestration.

## Gap 9: no operational safety controls yet

Before unattended real runs, add:

- campaign budget cap;
- max runs per day;
- max issues per day;
- max PRs per day;
- duplicate suppression;
- manual pause switch;
- emergency stop for repeated escape signatures;
- audit log of every authority-bearing action;
- explicit fixture vs real mode;
- dry-run mode for publication/fix flows.

## Gap 10: no real discovery corpus yet

The current probes are good scaffolding, but real attacks need broader surfaces:

- symlink and path traversal;
- archive extraction;
- shell injection through agent-generated payloads;
- process persistence and orphan cleanup;
- network/metadata endpoint access;
- environment secret leakage;
- controller artifact tampering;
- GitHub token abuse;
- prompt injection against publisher/fixer;
- replay-policy tampering;
- nested tool or MCP escape;
- patch receipt manipulation.

## Recommended next order

1. Run one more synthetic issue → PR cycle and confirm native `pull_request` replay attachment.
2. Add branch protection / required replay check for synthetic fixture PRs.
3. Add payload envelope and bounded adaptive attack execution, but keep publication disabled.
4. Add real evidence bundle schema and dedupe signature.
5. Add AI fixer on isolated branch, with no merge authority.
6. Add real publisher guardrails behind manual approval.
7. Add low-rate real campaign scheduling.
8. Add Cloudflare durable control plane only when campaign state outgrows GitHub Actions.

The key rule remains:

```text
attacker may discover
verifier may reproduce
publisher may publish
fixer may patch
controller may merge

No one role gets all five powers.
```
