# Wake Continuity Head-to-Head

Status: complete

## Question

Did Terrarium make the parent agent better at building Wake than the same agent without Terrarium?

Wake target: tiny local CLI for durable agent-run continuity after terminal/session loss.

## Commands run

Baseline:

```sh
cd /Users/jcoeyman/cloudflare/terrarium
opencode run "$(cat evals/wake-continuity/task-no-terrarium.md)" \
  | tee evals/wake-continuity/runs/no-terrarium/transcript.txt
```

Treatment:

```sh
cd /Users/jcoeyman/cloudflare/terrarium
opencode run "$(cat evals/wake-continuity/task-with-terrarium.md)" \
  | tee evals/wake-continuity/runs/with-terrarium/transcript.txt
```

Important harness finding: the first treatment attempt used synchronous MCP spawn and hit MCP timeout. Terrarium was patched with `background: true`, then treatment was rerun successfully.

## Artifacts

Baseline repo:

```text
evals/wake-continuity/runs/no-terrarium/wake
```

Treatment repo:

```text
evals/wake-continuity/runs/with-terrarium/wake
```

Treatment Terrarium design run:

```text
ter_20260501085459062_0fxbv5
/Users/jcoeyman/.terrarium/runs/ter_20260501085459062_0fxbv5.log
```

## Verification

Baseline:

```sh
cd evals/wake-continuity/runs/no-terrarium/wake
python3 -m unittest test_wake.py -v
```

Result:

```text
test_full_lifecycle (test_wake.WakeFlowTest) ... ok
Ran 1 test in 0.413s
OK
```

Treatment:

```sh
cd evals/wake-continuity/runs/with-terrarium/wake
npm test
```

Result:

```text
# tests 3
# pass 3
# fail 0
```

## Scores

Rubric max: 14.

| Category | Baseline | Treatment | Notes |
|---|---:|---:|---|
| Problem clarity | 2 | 2 | Both explain terminal/session loss clearly. Treatment has sharper "tomorrow morning" framing. |
| CLI usability | 1 | 2 | Baseline has required loop but README documents `--run` for status even though implementation output was not verified for that flag. Treatment has start/note/status/handoff plus resume/list and documents resolution order. |
| Durable state | 2 | 2 | Both persist under WAKE_HOME/`~/.wake`. Treatment uses run.json + append-only journal + HANDOFF.md + active/last. |
| Handoff quality | 2 | 2 | Both include objective, decisions, attempts, files, commands, failures, next step. |
| Minimality | 2 | 2 | Both small. Baseline is single-file Python. Treatment is slightly more structured but still tiny. |
| Verification | 1 | 2 | Baseline has one real lifecycle test. Treatment has three tests including simulated session loss, WAKE_HOME isolation, active-run guard. |
| Fresh-agent resumability | 1 | 2 | Baseline says `cat ~/.wake/runs/<run-id>/handoff.md`; treatment has `wake resume` resolving id from --id/env/active/last/most-recent. |

Baseline: **11/14**

Treatment: **14/14**

## Concrete difference Terrarium caused

The Terrarium child design side quest recommended the core improvement that made treatment win: an explicit resume path with active/last pointer files and durable append-only journal.

Treatment README:

```text
wake resume
Prints HANDOFF.md if available, otherwise renders status. Resolves a run
from (in order): --id, $WAKE_RUN_ID, ~/.wake/active, ~/.wake/last,
or the most-recent run directory.
```

Baseline has a good handoff file, but tomorrow-morning recovery still expects the user to remember or find the run id/path.

## Parent context observation

Transcript sizes:

```text
baseline transcript: 2599 bytes
treatment transcript: 2987 bytes
```

Treatment parent carried a little more orchestration text, but avoided doing the design exploration inline. The child summary was used as a design input, then parent implemented. This is the intended Terrarium shape: side quest first, focused implementation after.

## Harness bug found and fixed

Synchronous `terrarium_spawn` over MCP is unsafe for long-running child agents because the MCP call can time out before the child completes.

Fix added:

```json
{
  "background": true
}
```

Now `terrarium_spawn` returns immediately with `runId`, `pid`, and `logPath`. Parent polls with `terrarium_status` / `terrarium_read`.

This is a product-relevant finding from the eval, not incidental cleanup.

## Verdict

Terrarium: **helped**

Why:

- It produced a stronger design before implementation without making the parent do the design dig inline.
- The treatment artifact solved the actual user pain more directly: `wake resume` works after terminal/session loss without remembering the run id.
- It forced a real Terrarium MCP improvement (`background: true`) needed for practical use.

Evidence:

- baseline score: 11/14
- treatment score: 14/14
- treatment runId: `ter_20260501085459062_0fxbv5`
- concrete difference: treatment added active/last pointers + `wake resume`; baseline requires finding/catting a handoff path.

## Recommendation

Keep Terrarium positioned as:

```text
side quests for agents
```

Use this eval as the README proof story:

```text
We asked the same agent to build Wake twice. The Terrarium run used one child for design first, then implemented. It scored higher because the child found the key continuity primitive: resume without remembering the session id.
```

Next Terrarium improvement: make `background: true` the recommended MCP path for agent children, and document the polling loop prominently.
