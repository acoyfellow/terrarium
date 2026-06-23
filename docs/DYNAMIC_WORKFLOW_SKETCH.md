# Dynamic workflow sketch

> **Frozen historical design.** Terrarium gained the bounded Lab/control-worker pieces described here, but the public autonomous campaign is now maintenance-only provenance. This sketch is not the current roadmap; see [CORE_PRODUCT_DECISION.md](./CORE_PRODUCT_DECISION.md).

This was the intended Cloudflare-native control flow for the campaign path.

```text
Cloudflare Dynamic Workflow
  → load campaign policy
  → stop if paused
  → stop if daily cap reached
  → stop if cooldown not elapsed
  → choose one scenario
  → ask Terrarium attacker for one bounded payload
  → send payload to Lab
  → inspect Lab receipt
  → replay in fresh Lab isolate if escaped
  → write Terrarium campaign receipt
  → create sanitized GitHub issue if verified
  → ask fixer for one bounded patch
  → open PR
  → run Lab/Docker replay gate
  → merge only if policy allows and replay passes
  → schedule next eligible run
```

## Workflow shape

```ts
export class TerrariumCampaignWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const policy = await step.do("load-policy", async () => {
      return await loadCampaignPolicy(event.payload.mode);
    });

    await step.do("guardrails", async () => {
      if (policy.paused) throw new Error("campaigns paused");
      if (await runsToday() >= policy.maxRunsPerDay) throw new Error("daily run cap reached");
      if (await cooldownActive(policy.cooldownMinutes)) throw new Error("cooldown active");
    });

    const scenario = await step.do("choose-scenario", async () => {
      return await chooseScenario(policy);
    });

    const proposal = await step.do("attacker", async () => {
      return await terrariumAttack({
        scenarioId: scenario.id,
        backend: "lab",
        maxBytes: policy.maxPayloadBytes,
        capabilities: [],
      });
    });

    const execution = await step.do("lab-run", async () => {
      return await lab.runSandbox({
        body: proposal.body,
        capabilities: [],
      });
    });

    const verdict = await step.do("detector", async () => {
      return await detectScenarioOutcome(scenario, execution);
    });

    const replay = verdict.verdict === "escaped"
      ? await step.do("fresh-replay", async () => {
          return await lab.runSandbox({
            body: proposal.body,
            capabilities: [],
          });
        })
      : null;

    const verified = replay
      ? await step.do("verify-replay", async () => {
          return await detectScenarioOutcome(scenario, replay);
        })
      : null;

    const receipt = await step.do("write-receipt", async () => {
      return await writeCampaignReceipt({
        scenario,
        proposal,
        execution,
        verdict,
        replay,
        verified,
      });
    });

    if (verified?.verdict !== "escaped") {
      return { status: "contained", receiptId: receipt.id };
    }

    const issue = await step.do("publish-issue", async () => {
      return await publishVerifiedIssue(receipt);
    });

    const fix = await step.do("fixer", async () => {
      return await terrariumFix({
        issue,
        isolation: "worktree",
      });
    });

    const pr = await step.do("open-pr", async () => {
      return await openFixPullRequest(issue, fix);
    });

    const gate = await step.do("replay-gate", async () => {
      return await replayFixAgainstPr(pr, scenario, proposal.body);
    });

    if (gate.passed && policy.allowAutoMerge) {
      await step.do("merge", async () => {
        await mergePullRequest(pr.number);
      });
    }

    return {
      status: gate.passed ? "fixed" : "needs-review",
      receiptId: receipt.id,
      issueNumber: issue.number,
      prNumber: pr.number,
    };
  }
}
```

## Policy

```ts
const policy = {
  paused: false,
  maxRunsPerDay: 3,
  maxVerifiedEscapesPerDay: 1,
  maxIssuesPerDay: 1,
  maxFixPrsPerDay: 1,
  cooldownMinutes: 60,
  maxPayloadBytes: 4096,
  allowFixture: true,
  allowReal: false,
  allowAutoMerge: false,
};
```

## Important authority split

```text
attacker
  may propose one payload
  may not publish
  may not merge
  may not access secrets

Lab
  may execute bounded payload
  may not publish
  may not merge

verifier
  may replay
  may not publish raw output
  may not merge

publisher
  may open sanitized issue
  may not execute attacker code
  may not merge

fixer
  may patch branch
  may not publish issue
  may not merge

controller
  may schedule, dedupe, pause, and merge only under policy
```

## Why Dynamic Workflows fit

Dynamic Workflows are better than one long GitHub Action for this because the loop is naturally branching:

```text
contained → stop
escaped but not replayed → stop
verified escape → publish issue
issue already exists → stop
fix passes replay → optionally merge
fix fails replay → leave PR open
```

Each branch can be a durable step with retry state, timeout, audit metadata, and explicit policy checks.

## First implementation target

Do not begin with the full workflow above.

Start with:

```text
fixture scenario
  → Lab run
  → replay
  → receipt
  → no publication
```

Then add:

```text
verified fixture → issue
```

Then:

```text
issue → deterministic fix PR → replay gate
```

Then replace deterministic fix with AI fixer.
