# Pulse

**Durable callback plumbing for delegated work.**

When one process hands a bounded task to another, the result needs to survive
restarts, races, and slow consumers. Pulse is the small piece that makes that
reliable:

- **emit** a terminal event when work finishes;
- **journal + dedupe** it so the same result never lands twice;
- **fan out** to every matching subscriber;
- **claim** events later, even if the consumer was offline when they fired;
- **ack** after handling, at-least-once with dedup;
- **requeue** stale inflight events a consumer claimed but never acked;
- **status** for mailbox visibility.

Pulse is **not** a workflow engine, a memory store, a proof system, or an agent
framework. It is the callback layer those things sit on top of.

## Quick start

```sh
cd pulse
npm install
npm test          # router + server contract tests
npm run build     # build the Svelte docs/demo site
npm run e2e:docs  # dogfood Pulse on its own docs build event
npm run dev       # serve the Hono API on :8787
```

## Shape

```text
pulse/
  src/schema.js          # event/subscriber validation + deterministic event ids
  src/router.js          # in-memory transport core (mirrors the Worker/DO contract)
  src/server.js          # Hono app — Worker-compatible fetch handler
  site/src/App.svelte    # docs/demo UI (runs the real router in the browser)
  test/*.test.js         # lifecycle + auth contract tests
  scripts/e2e-docs.mjs   # subscribe -> emit -> claim -> ack dogfood
  vite.config.js
```

The Svelte demo, the Hono server, the tests, and the e2e script all share the
same `src/router.js` and `src/schema.js` — one protocol, four front doors.

## HTTP API

All routes except `/health` require `Authorization: Bearer $PULSE_TOKEN`
(fail-closed: no token configured, or no token presented, returns `401`).

| Method | Path      | Purpose                                              |
| ------ | --------- | ---------------------------------------------------- |
| GET    | `/health` | liveness                                             |
| POST   | `/pulse`  | `emit` / `subscribe` / `unsubscribe` / `requeue`     |
| POST   | `/claim`  | claim pending mailbox events                         |
| POST   | `/ack`    | acknowledge an inflight event                        |
| GET    | `/status` | mailbox counts for a subscriber                      |

```sh
# subscribe a docs consumer
curl -s localhost:8787/pulse -H "authorization: Bearer $PULSE_TOKEN" \
  -d '{"action":"subscribe","subscriberId":"docs-consumer","channels":["docs"]}'

# emit a terminal event
curl -s localhost:8787/pulse -H "authorization: Bearer $PULSE_TOKEN" \
  -d '{"action":"emit","type":"Completed","runId":"ter_docs1","channel":"docs","at":"2026-06-30T00:00:00.000Z","status":"done","exitCode":0,"ok":true}'

# claim, then ack
curl -s localhost:8787/claim -H "authorization: Bearer $PULSE_TOKEN" \
  -d '{"subscriberId":"docs-consumer"}'
curl -s localhost:8787/ack -H "authorization: Bearer $PULSE_TOKEN" \
  -d '{"subscriberId":"docs-consumer","eventId":"evt_..."}'
```

## Contract notes

- Terminal event types: `Completed`, `Failed`, `TimedOut`, `Cancelled`.
- Delivery is at-least-once with per-mailbox dedup on a deterministic `eventId`.
- A terminal callback means a run finished — it is a notification, not proof the
  task succeeded. Confirm with the run's own receipt.
- Owner isolation is enforced at `claim`/`ack`/`status`/`requeue`: one owner can
  never read or settle another owner's mailbox.

See [`EXTRACTION.md`](./EXTRACTION.md) for how this relates to Terrarium.
