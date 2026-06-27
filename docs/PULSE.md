# Pulse — durable edge wake transport

Terrarium's local callback router (journal → claim → ack → replay, with per-owner mailboxes) lives in the filesystem and only works while the parent process is around. Pulse lifts that exact router onto Cloudflare so a finished run can reach the right consumer **across closes, sessions, and machines** — when the agent that started the work is no longer running, or is running somewhere else.

**Promise:** a terminal run event emitted once is durably journaled at the edge and delivered at-least-once, with dedup, to every subscriber whose filters match, and only the owning run can claim, ack, or read its mailbox.

Status: live in production at `terrarium.coey.dev` and proven end-to-end (emit → claim → ack, dedup, journal replay, per-owner isolation, fail-closed auth). v0 — no consumer reads from it yet (see [Limits](#limits-and-non-goals)).

## How it works

```text
  emitter                  Worker (control)              PulseRouter Durable Object
  (run finished)           token gate, fail-closed       (one per router name, DO SQLite)
      │                          │                                │
      │  POST /pulse  ──────────►│  Bearer == PULSE_TOKEN?        │
      │  (terminal event)        │  ──── route ──────────────────►│ journal[eventId]  (dedup)
      │                          │                                │ fan out to matching
      │                          │                                │ subscribers' mailboxes
      │                          │                                │   → pending
      │                          │                                │
  consumer                       │                                │
      │  POST /claim  ──────────►│  ──── claim ──────────────────►│ pending → inflight
      │  (events)     ◄──────────│◄───────────────────────────────│
      │  POST /ack    ──────────►│  ──── ack ────────────────────►│ inflight → acked
      │  GET  /status ──────────►│  ──── status ─────────────────►│ counts
```

- **One Durable Object per router name** keeps the journal, subscribers, and mailboxes colocated and serialized. The name is regex-clamped (`^[A-Za-z0-9_-]{1,64}$`); anything else falls back to the default `global`. Callers may shard via `?router=` or a `router` field in the body.
- **DO SQLite tables** (`src/pulse/do.js`): `journal(event_id, payload, at)` is the dedup + replay source of truth; `subscribers(...)` holds filter lists and `owner_run_id`; `mailbox(subscriber_id, event_id, state, ...)` carries each event through `pending → inflight → acked`.
- **eventId = sha256 of `[runId, type, at, status, exitCode]`** (`src/pulse/shared.js`). The same terminal event always hashes to the same id, so re-emitting is a no-op and a given id appears at most once per mailbox.
- Mounted through the existing merged control worker (`src/control-worker.js`), which delegates `/pulse`, `/claim`, `/ack`, and `/status` to the Pulse worker (`src/pulse/worker.js`). The DO migration is additive (`v2 new_sqlite_classes: ["PulseRouter"]`) over the existing `CampaignLock` v1.

## Auth

Every route except `GET /health` requires a capability bearer token compared against the `PULSE_TOKEN` secret with a constant-time comparison. It is **fail-closed**: a missing request token *or* an unset `PULSE_TOKEN` env returns `401`. There are no secrets in code; `PULSE_TOKEN` is a wrangler secret. In production, Cloudflare Access (Zero Trust) sits in front of this token gate, and `workers_dev` / `preview_urls` are disabled.

## Quick start (curl)

```sh
PULSE=https://terrarium.coey.dev        # or http://127.0.0.1:8787 with `wrangler dev`
TOKEN=...                               # the value of the PULSE_TOKEN secret

# 1. A consumer subscribes (here, to one concrete run it cares about).
curl -s "$PULSE/pulse" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"subscribe","args":{
        "subscriberId":"my-consumer",
        "runIds":["ter_abc123"],
        "ownerRunId":"ter_owner1"}}'

# 2. The run finishes and emits a terminal event.
curl -s "$PULSE/pulse" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"action":"emit","event":{
        "runId":"ter_abc123",
        "type":"Completed",
        "status":"done",
        "exitCode":0,
        "at":"2026-06-27T12:00:00.000Z"}}'
# -> {"ok":true,"result":{"eventId":"<sha256>","duplicate":false,"delivered":1}}

# 3. The consumer claims pending events (pending -> inflight).
curl -s "$PULSE/claim" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"subscriberId":"my-consumer","ownerRunId":"ter_owner1","limit":20}'

# 4. The consumer acks after handling (inflight -> acked; idempotent).
curl -s "$PULSE/ack" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"subscriberId":"my-consumer","ownerRunId":"ter_owner1","eventId":"<sha256>"}'

# 5. Inspect mailbox counts at any time.
curl -s "$PULSE/status?subscriberId=my-consumer&ownerRunId=ter_owner1" \
  -H "authorization: Bearer $TOKEN"
# -> {"ok":true,"result":{"subscriberId":"my-consumer","pending":0,"inflight":0,"acknowledged":1}}
```

`POST /pulse` also accepts `action: "unsubscribe"`, `requeue`, and `getSubscriber`. Stale inflight events can be returned to pending with `requeue` (default `olderThanMs: 300000`).

## What it proves

Each guarantee below is held by a named test. They mirror the filesystem router's contract (`test/router.test.js`) so both backends behave the same.

| Guarantee | Where it is proven |
| --- | --- |
| Happy path: emit → route → claim → ack | `test/pulse-do.test.js`, `test/pulse-e2e.test.js`, `test/pulse-worker-e2e.test.js` (gate 1, full worker+DO+SQLite) |
| At-least-once delivery with dedup (same `eventId`, no second delivery) | `test/pulse-do.test.js`, `test/pulse-e2e.test.js` |
| Finish-before-subscribe replays the journal for concrete `runIds` | `test/pulse-do.test.js`, `test/pulse-e2e.test.js`, `test/pulse-worker-e2e.test.js` |
| Claim → ack is idempotent | `test/pulse-do.test.js`, `test/pulse-e2e.test.js` |
| Cross-owner isolation: a different `ownerRunId` cannot claim/ack/read status of another mailbox (`403` through the real worker) | `test/pulse-do.test.js`, `test/pulse-e2e.test.js`, `test/pulse-worker-e2e.test.js` |
| Requeue moves stale inflight back to pending and leaves not-yet-stale alone | `test/pulse-do.test.js` |
| Auth is fail-closed (401 on every gated route, and when `PULSE_TOKEN` is unset) | `test/pulse-e2e.test.js`, `test/pulse-worker-e2e.test.js` |
| Adversarial: malformed / non-terminal events rejected; oversized/unbounded filters rejected; ack-unclaimed and ack-nonexistent throw; `pi-*`/`pi_` wildcard subscriber holding `"*"` receives no delivery; tampered owner/timestamp records fail closed before the owner check | `test/pulse-do.test.js` |
| Prod topology: `/pulse`, `/claim`, `/ack`, `/status` reach the worker (hitting the token gate) instead of the SPA fallback, and an unknown route still gets the SPA index | `test/pulse-assets-topology.test.js` |

Run them:

```sh
node --test test/pulse-do.test.js test/pulse-e2e.test.js \
            test/pulse-worker-e2e.test.js test/pulse-assets-topology.test.js
```

## Limits and non-goals

Stated plainly, because the [7-minute-repo rule](../README.md) requires it:

- **Isolation is enforced at claim/ack/status/requeue/unsubscribe, not at delivery/match.** `matches()` has no `ownerRunId` dimension: a single event may legitimately fan out to subscribers owned by different runs, and what an owner must *not* do is read or settle *another* owner's mailbox. This is a conscious host-trust choice that mirrors the filesystem router — the journal and mailboxes live inside one trusted DO. Pushing ownership into matching would wrongly suppress legitimate multi-owner fan-out. See the long comment in `route()` in `src/pulse/do.js`.
- **DO durability under long hibernation is not separately stress-tested.** Production e2e (2026-06-27) verified the full path live — including journal replay across separate HTTP isolate invocations, which exercises DO SQLite persistence — but a dedicated long-eviction/hibernation durability test has not been written. Coverage: DO unit tests, Miniflare HTTP e2e, an asset-topology test, and a live prod e2e.
- **Consumers are not yet rewired.** glance, mote, my-ax push, and the Pi extension still read from the local filesystem router; reading from the cloud router is downstream work, not part of this transport.
- Pulse is a **transport**, not a memory or workflow system. It does not resume an agent conversation, store run results, or own continuity — it carries terminal wake events to whoever is listening.

## Where to edit behavior

| To change… | Edit… |
| --- | --- |
| Journal/mailbox semantics, dedup, replay, owner checks, requeue | `src/pulse/do.js` (`PulseRouter`) |
| Validation, matching, terminal event types, `eventId` derivation, filter bounds | `src/pulse/shared.js` (shared with `src/router.js`) |
| HTTP routes, token gate, router sharding | `src/pulse/worker.js` |
| Where the routes mount in the merged worker | `src/control-worker.js` |
| DO binding, migration, route ordering vs the SPA fallback | `wrangler.jsonc` (`durable_objects`, `migrations`, `assets.run_worker_first`) |
