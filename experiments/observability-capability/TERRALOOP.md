# Capability-scoped failure context Terraloop

This is a disposable Terrarium experiment. It tests whether a child agent can consume
strictly scoped evidence from its own failed run and make a better bounded follow-up without
receiving Cloudflare credentials, arbitrary observability access, or authority to mutate the
ledger.

## North Star

A failed Terrarium produces durable, normalized evidence. A permitted follow-up child can
mechanically inspect only that evidence, explain the failure, choose a permitted repair, and
produce a separately verified result. A child cannot enumerate other runs, read another
principal's evidence, reveal secrets, expand its scope, or mark itself successful.

## Falsifiable claim

A server-mediated, signed capability can expose sufficient failure context for a child to
avoid a known repeatable mistake while preserving run/principal isolation and no-write
authority.

## The smallest question

Can a `terrarium_observe` capability let a child read the terminal reason and bounded
redacted log tail for one explicitly delegated predecessor run, while refusing all sibling,
foreign-principal, arbitrary-query, expired-token, oversized-result, and mutation attempts?

## Fixed authority model

- No Cloudflare API token, account credential, raw Worker log query, or R2 credential enters
a child environment or prompt.
- The supervisor seals a short-lived signed grant containing subject run, permitted predecessor
run IDs, allowed evidence kinds, byte/result budget, principal, expiry, and `read` action.
- The observation service verifies the grant and resolves evidence server-side.
- Returned records are normalized/redacted; the child cannot request raw prompts, headers,
credentials, or account-wide observability.
- The child cannot write a terminal state, refresh/forge a grant, widen a run/principal scope,
or treat its own answer as verification.

## Parallel experiments

1. **Protocol design:** independently specify a minimal grant and response schema.
2. **Adversarial isolation:** attempt sibling, foreign-principal, wildcard, expiry, budget,
   replay, and write escalation bypasses.
3. **Repair utility:** give a bounded child a startup-timeout failure and ask it to choose the
   permitted non-repeat action from evidence alone.
4. **Operator ergonomics:** compare a parent-only diagnosis with the child-visible normalized
   failure record; identify the minimum fields that prevent blind retries.

## Required hammer

The experiment must deposit a deterministic local reference evaluator:

```text
issueGrant → observe(grant, query) → normalized evidence or refusal
```

It must be usable by a later real Worker/DO implementation without changing the authority
invariants.

## Stop gate

Green requires all of:

- a control grant returns only its named predecessor's normalized terminal evidence;
- every adversarial scope/expiry/budget/write mutation is refused deterministically;
- a repair consumer can distinguish `startup-timeout` from provider identity failure using the
  returned evidence, but cannot assert a verified outcome;
- no secret-like value appears in child-visible output;
- the result is replayed from a clean detached checkout;
- at least one independent critic finds no unaddressed privilege-escalation path.

Red is useful: a bypass becomes a permanent mutation or the experiment records why the
capability should not exist.

## Explicit non-goals

No Cloudflare deployment, production log access, real customer data, broad Worker analytics,
baseline/fleet execution, credential delegation, or automatic retry is authorized by this
experiment.

## Tick behavior

Run competing design and attack attempts in isolated/read-only Terrariums. Treat terminal
receipts as evidence, not conclusions. Synthesize the smallest mechanical contract, implement
only the reference evaluator required by the stop gate, run its mutation corpus, record the
failure/acceptance matrix, and stop.
