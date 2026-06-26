# Product hardening loop

Terrarium's public story should be a byproduct of useful product work, not a content factory.

One loop iteration must fit in the repo's seven-minute operating constraint and follow this shape:

```text
OBSERVE -> SELECT -> EXECUTE -> VERIFY -> RECORD -> PUBLIC_SUMMARIZE -> OPTIONAL_DEPLOY
```

## Rules

1. Product hardening comes first.
2. If health is red, repair or record the blocker; do not publish a win.
3. A public campaign turn is optional and downstream of verified work.
4. `evidenceClaim: true` requires a checkable evidence reference such as a commit, test, replay fixture, or validated Terrarium run receipt.
5. Public summaries must not contain private run metadata, task prompts, child output, cwd, or log paths.
6. Editorial images are allowed only as illustrations. They are not evidence.

## Run one iteration

```sh
npm run product-loop:once
```

The command writes:

```text
receipts/product-loop/<iteration>.json              # private/local iteration receipt
app/public/campaign/receipts/<iteration>.public.json # public-safe summary
```

It also runs the minimum health gate:

```text
git status --short
npm run demo:build
node --test test/product-loop.test.js
```

If the gate fails, the receipt records `canPublishStory: false`. The next iteration should repair the blocker instead of creating a public campaign win.

## Validate truthfulness

```sh
npm run product-loop:validate
```

This validates receipt shape and checks that public campaign turns do not claim evidence without checkable metadata.

## What counts as good work

Prefer small verified product hardening tasks:

- classify runner-busy failures as retryable runner failures;
- improve `terra doctor` diagnostics;
- add replay fixtures for races;
- tighten callback privacy or routing;
- reduce operator confusion with a testable behavior change;
- record a useful negative result.

Storytelling happens after verification. A good public turn says what changed in the product, then uses the robot-in-a-jar world to make it memorable.
