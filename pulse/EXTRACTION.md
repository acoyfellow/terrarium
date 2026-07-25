# Relationship to Terrarium

Pulse is the durable callback layer extracted from
[Terrarium](../). In Terrarium it is the plumbing behind `terrarium_callbacks`:
a child run finishes, emits a terminal event, and the parent (or any subscriber)
claims and acks it later — surviving offline/restart races with at-least-once
delivery and dedup.

## What was lifted

This standalone v0 adapts, with the same protocol and validation semantics:

| Standalone file   | Terrarium origin                  | Notes                                            |
| ----------------- | --------------------------------- | ------------------------------------------------ |
| `src/schema.js`   | `src/pulse/shared.js`             | event/subscriber validation, deterministic ids   |
| `src/router.js`   | `src/pulse/do.js` (`PulseRouter`) | in-memory store instead of `ctx.storage.sql`     |
| `src/server.js`   | `src/pulse/worker.js`             | Hono app instead of a hand-rolled Worker fetch   |

The validation rules, terminal event types, deterministic `eventId` derivation,
the `pi-*`/`pi_*` wildcard fan-out guard, and owner isolation are kept identical,
so an event routed through this local adapter collapses to the same id and shape
as one routed through the Cloudflare Durable Object backend.

## What is intentionally different

- **Storage.** The standalone router uses plain JS `Map`s for a zero-dependency
  local v0. The Cloudflare backend uses SQLite inside a Durable Object. Swapping
  the store does not change the caller-facing contract.
- **Scope.** This package is deliberately small: emit / journal / dedupe / fan
  out / claim / ack / requeue / status. It does not carry Terrarium's spawn,
  groups, lab, or orchestration surface.

## What it is not

Same doctrine as upstream: Pulse is callback plumbing, not workflow, not memory,
not proof, not an agent framework. Pair it with whatever continuity/memory and
execution layers you already have.
