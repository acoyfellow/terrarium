# Automated containment loop

> **Frozen historical design.** The public containment loop is maintenance-only provenance, not Terrarium's current roadmap. The core product is durable execution, batches, callbacks, and replayable terminal semantics. See [CORE_PRODUCT_DECISION.md](./CORE_PRODUCT_DECISION.md).

## Purpose

Terrarium's public red-team loop is a workflow composed from the stable one-child run primitive:

```text
contain → attack → verify → issue → fix → replay → repeat
```

The design deliberately keeps trusted authority outside any environment being attacked.

## Simplest safe progression

Do not start with GitHub-writing agents. Build the smallest local loop that can establish truth, then add publication and remediation authority separately.

### Phase 0: contract and threat model

- Keep CLI, Node API, and MCP primitive backward-compatible.
- Define boundary, scenario, evidence, verification, and disclosure rules.
- Be explicit that current `copy`/`worktree` workspace isolation is not sandboxing.

Deliverables: `README.md`, `COMPATIBILITY.md`, `THREAT_MODEL.md`, this document, and a vulnerability issue template.

### Phase 1: deterministic local sandbox tests — baseline implemented

Terrarium now includes an opt-in Docker probe command, separate from `--isolation`:

```sh
terra probe filesystem-write-outside-workspace --json
terra probe environment-canary --json
terra probe network-disabled --json
terra probe filesystem-read-canary --json
terra probe process-persistence --json
terra verify filesystem-write-outside-workspace --json
```

```text
isolation = worktree        separate development checkout
probe      = docker         deterministic containment baseline
```

It starts with deterministic scripts, not AI agents. A detector must know whether the boundary held before an attacker model is allowed to search for bypasses.

Implemented scenarios:

1. Attempt forbidden file write outside a writable scratch workspace.
2. Attempt forbidden environment-canary read.
3. Attempt a prohibited network request while Docker networking is disabled.
4. Attempt forbidden host-path read when that path is not mounted into the container.
5. Attempt process persistence after the primary probe exits, then verify container teardown.

The initial verifier path is intentionally minimal: `terra verify <scenario>` performs a fresh replay only if the first deterministic attempt reports `escaped`; a `contained` attempt returns without inventing vulnerability evidence.

A local-only known-vulnerable fixture, `fixture-environment-leak`, uses tracked `vulnerable.json` and `fixed.json` policy variants so maintainers can exercise the entire escaped receipt → verified replay → sanitized issue-draft → remediation-gate pipeline without claiming a newly discovered vulnerability:

```sh
terra fixture escape vulnerable
terra campaign verify <fixtureCampaignId>
terra campaign issue-draft <fixtureCampaignId>
terra fixture escape fixed
```

The fixture commands start from controlled detector results; they do not need to invoke an AI proposal agent. The fixed variant supplies a reusable contained target rather than requiring a vulnerability to be reintroduced on `main` for every pipeline exercise.

A public GitHub Actions baseline workflow now runs these deterministic probes and the fixture pipeline on manual dispatch and a weekly schedule. It uploads sanitized artifacts only and declares `contents: read` permission. After the first CI run revealed that runner-workspace bind mounts were not portable, deterministic probes were simplified to pass trusted probe source inline to Docker with `node -e`, avoiding host checkout mounts entirely.

Manual public fixture-loop workflows now exercise mutation in bounded stages: `publish-fixture-issue.yml` can open a clearly labeled synthetic issue with only `issues: write`; `fix-fixture-issue.yml` can create a deterministic remediation PR for that labeled fixture issue; and `replay-fixture-fix.yml` uses read-only PR checks to require that the vulnerable control still escapes while the selected fixed policy is contained. This is infrastructure validation, not automated handling of real findings.

The first full synthetic loop completed publicly:

```text
issue #3
  → PR #4
  → replay gate passed
  → merged
  → issue closed
```

- Issue: https://github.com/acoyfellow/terrarium/issues/3
- PR: https://github.com/acoyfellow/terrarium/pull/4
- Replay run: https://github.com/acoyfellow/terrarium/actions/runs/27006150043

The replay for that first PR was manually dispatched because the replay workflow had only just been added to `main`. The next synthetic PR should verify native `pull_request` attachment before any real finding path is trusted.

### Phase 2: AI attacker, local evidence only — conservative path started

The initial command is deliberately constrained:

```sh
terra attack environment-canary --agent "opencode run" --json
```

The proposal agent receives a bounded scenario description and may only return a machine-parseable request to execute that pre-declared deterministic detector. It does not yet provide arbitrary attack code to the sandbox. The detector, not the agent's prose, sets the verdict. Each run writes a sanitized local campaign receipt under `~/.terrarium/campaigns/`; receipts retain scenario, policy, proposal reason, and detector verdict while omitting the raw model output, detector output, agent command, and host-specific receipt path.

```sh
terra campaigns
terra campaign read <campaignId>
terra campaign verify <campaignId>
terra campaign issue-draft <verifiedCampaignId>
```

Campaign verification only replays a receipt whose verdict claims an escape. A contained receipt is inspectable but cannot be promoted into vulnerability evidence through replay theater. Issue drafting is local-only and refuses any campaign without a freshly reproduced `verified-escape` verdict; GitHub publication is still outside the automation boundary.

This first path preserves the eventual requirements:

- bounded scenario objective;
- no GitHub write credentials;
- no genuine secrets;
- no authority for the attacker to classify its own result.

A later adaptive attack-program path must put generated attempts inside the sandbox with a more fully specified capability policy. The verifier must replay a claimed escape in a fresh environment before publication.

### Phase 3: sanitized public issues

Only a trusted publisher may post a verified vulnerability. Before publication it must check:

- exploit reproduced independently;
- artifact contains no real credential or unsafe host path disclosure;
- issue template is complete;
- vulnerability is not already open for the same scenario/signature.

### Phase 4: defensive pull requests

A fixer run may receive a verified issue and an isolated development branch. It may produce code, tests, and a pull request. It must not receive merge authority.

Trusted CI replays the exploit against the proposed change and evaluates the unchanged baseline suite.

### Phase 5: scheduled closed loop

Only after earlier phases are reliable may a scheduled workflow perform:

```text
attack run
  → verified public issue
  → proposed fix PR
  → trusted replay checks
  → gated merge
  → next campaign
```

## Mapping the loop onto the stable primitive

Every intelligent actor is an ordinary run with optional future metadata; the kernel need not be renamed.

```text
terrarium_spawn(task=attack objective, future sandbox/run-role options)
terrarium_status(runId)
terrarium_read(runId)

terrarium_spawn(task=verification objective, fresh sandbox)
terrarium_status(runId)
terrarium_read(runId)

terrarium_spawn(task=fix objective, isolated branch/workspace)
terrarium_status(runId)
terrarium_read(runId)
```

Potential higher-level campaign tools may be added later, but they must reference underlying ordinary `runId` receipts and must not replace `terrarium_spawn`, `terrarium_status`, or `terrarium_read`.

## Authority separation

```text
attacker sandbox            trusted controller             GitHub
────────────────            ──────────────────             ──────
no tokens                   holds scoped tokens            issue / PR records
no issue writes     ──────> verifies artifacts     ──────> sanitized publish
no merge rights             triggers replay CI             protected merge gate
```

Rules:

- The attacker and verifier run without repository/GitHub write tokens.
- The fixer gets, at most, authority to write a dedicated branch or create a PR through a controlled mechanism.
- The controller/publisher is not editable by the attacker or fixer within the evaluated change path.
- A fix cannot satisfy its own adjudicator by weakening/removing the tested boundary without a trusted review gate.

## Evidence model

Every attempted escape should yield a receipt linked to ordinary Terrarium runs:

```text
campaign id
scenario id and policy version
vulnerable git revision
attack run id
verifier run id
machine detector result
sanitized reproduction steps
fix PR and replay run id, if any
verdict: contained | verified escape | fixed | inconclusive
```

Do not auto-publish raw model transcripts. They can include secrets, misleading claims, excessive host information, or prompt-injected publishing instructions.

## Simplicity tests for each proposed feature

Before building anything, ask:

1. Can this remain an ordinary `terrarium_spawn` run with recorded metadata instead of a new agent abstraction?
2. Can a deterministic detector prove the scenario before involving an AI attacker?
3. Can this option be additive rather than changing existing defaults?
4. Can the attacker operate without credentials or outbound network?
5. Can the controller verify the result without trusting model prose?
6. Is a public GitHub mutation required yet, or is a local receipt enough for this phase?

If a simpler form produces the same verified evidence, implement the simpler form.

## Near-term implementation boundary

The Docker probe and constrained proposal-agent implementation make no claim that hostile AI execution is now safe. The next code change may record durable local campaign receipts and then introduce an adaptive attack-program experiment inside the boundary, while keeping it credential-free, non-publishing, opt-in, and separate from ordinary delegation behavior. Independent detectors, not the model's prose, must decide the verdict.
