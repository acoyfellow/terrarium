// PulseRouter Durable Object — the Cloudflare backend that mirrors the fs router
// (src/router.js) semantics on ctx.storage.sql.
//
// Tables:
//   subscribers(subscriber_id PK, channels, workflow_ids, event_types, run_ids,
//               owner_run_id, created_at, updated_at)  -- filter lists stored as JSON
//   journal(event_id PK, payload, at)                  -- dedup + replay source of truth
//   mailbox(subscriber_id, event_id, state, payload, claimed_at, PRIMARY KEY(subscriber_id,event_id))
//       state in ('pending','inflight','acked')
//
// Contract parity with the fs router:
//   - terminal event types Completed/Failed/TimedOut/Cancelled
//   - subscribers filter by channels/workflowIds/eventTypes/runIds + ownerRunId isolation
//   - claim -> deliver -> ack, at-least-once with dedup (event_id unique per mailbox)
//   - replay journal on subscribe for concrete run subscriptions (finish-before-subscribe)
//   - cross-owner isolation (ownerRunId mismatch => access denied)
//   - requeue inflight back to pending

import {
  TERMINAL_EVENT_TYPES,
  assertId,
  boundedList,
  sanitizeCallbackEvent,
  validTimestamp,
  isValidCallbackEvent,
  matches,
  mergeFilters,
  eventId as deriveEventId,
} from './shared.js';

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ownerOrNull(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^ter_[A-Za-z0-9_]+$/.test(value)) throw new Error('invalid subscriber owner run id');
  return value;
}

export class PulseRouter {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.#migrate();
  }

  #migrate() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subscribers (
      subscriber_id TEXT PRIMARY KEY,
      channels TEXT NOT NULL,
      workflow_ids TEXT NOT NULL,
      event_types TEXT NOT NULL,
      run_ids TEXT NOT NULL,
      owner_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS journal (
      event_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      at TEXT NOT NULL
    );`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mailbox (
      subscriber_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      state TEXT NOT NULL,
      payload TEXT NOT NULL,
      claimed_at TEXT,
      PRIMARY KEY (subscriber_id, event_id)
    );`);
  }

  #rowToSubscriber(row) {
    if (!row) return null;
    return {
      version: 1,
      subscriberId: row.subscriber_id,
      channels: JSON.parse(row.channels),
      workflowIds: JSON.parse(row.workflow_ids),
      eventTypes: JSON.parse(row.event_types),
      runIds: JSON.parse(row.run_ids),
      ownerRunId: row.owner_run_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #loadSubscriber(subscriberId) {
    const rows = this.sql.exec('SELECT * FROM subscribers WHERE subscriber_id = ?', subscriberId).toArray();
    return this.#rowToSubscriber(rows[0]);
  }

  // ---- public methods (called via fetch dispatch) ----

  getSubscriber(subscriberId) {
    assertId(subscriberId, 'subscriber id');
    const sub = this.#loadSubscriber(subscriberId);
    if (!sub) { const e = new Error('subscriber not found'); e.code = 'ENOENT'; throw e; }
    return sub;
  }

  #assertOwner(subscription, ownerRunId) {
    const stored = subscription.ownerRunId ?? null;
    if (stored !== (ownerRunId ?? null)) throw new Error('callback subscriber access denied');
  }

  async subscribe(subscription) {
    const subscriberId = assertId(subscription.subscriberId, 'subscriber id');
    const requestedOwner = ownerOrNull(subscription.ownerRunId);
    const existing = this.#loadSubscriber(subscriberId);
    if (existing && (existing.ownerRunId ?? null) !== requestedOwner) {
      // Re-subscription must not silently re-home an existing subscriber.
      throw new Error('subscriber is owned by another run or controller');
    }
    const ownerRunId = requestedOwner ?? existing?.ownerRunId ?? null;
    const now = new Date().toISOString();
    const normalized = {
      version: 1,
      subscriberId,
      channels: mergeFilters(subscription.channels, existing?.channels, ['*']),
      workflowIds: mergeFilters(subscription.workflowIds, existing?.workflowIds, ['*']),
      eventTypes: mergeFilters(subscription.eventTypes, existing?.eventTypes, TERMINAL_EVENT_TYPES),
      runIds: mergeFilters(subscription.runIds, existing?.runIds, ['*'], { narrowWildcard: subscription.narrowWildcardRunIds === true }),
      ownerRunId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sql.exec(
      `INSERT INTO subscribers (subscriber_id, channels, workflow_ids, event_types, run_ids, owner_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subscriber_id) DO UPDATE SET
         channels=excluded.channels, workflow_ids=excluded.workflow_ids,
         event_types=excluded.event_types, run_ids=excluded.run_ids,
         owner_run_id=excluded.owner_run_id, updated_at=excluded.updated_at`,
      subscriberId,
      JSON.stringify(normalized.channels),
      JSON.stringify(normalized.workflowIds),
      JSON.stringify(normalized.eventTypes),
      JSON.stringify(normalized.runIds),
      normalized.ownerRunId,
      normalized.createdAt,
      normalized.updatedAt,
    );

    // Replay: only concrete (non-wildcard) run subscriptions replay journal history.
    // Match against the *requested* filters (not merged) like the fs router.
    const requestedRuns = boundedList(subscription.runIds);
    const replayed = requestedRuns.includes('*') ? 0 : this.#replay({
      subscriberId,
      channels: boundedList(subscription.channels),
      workflowIds: boundedList(subscription.workflowIds),
      eventTypes: boundedList(subscription.eventTypes, TERMINAL_EVENT_TYPES),
      runIds: requestedRuns,
    });
    return { ...normalized, replayed };
  }

  #replay(requestedSubscription) {
    let replayed = 0;
    const rows = this.sql.exec('SELECT event_id, payload FROM journal ORDER BY event_id ASC').toArray();
    for (const row of rows) {
      let event;
      try { event = sanitizeCallbackEvent(JSON.parse(row.payload)); } catch { continue; }
      if (!isValidCallbackEvent(event, row.event_id, { state: 'pending' })) continue;
      if (!matches(requestedSubscription, event)) continue;
      if (this.#enqueue(requestedSubscription.subscriberId, event)) replayed++;
    }
    return replayed;
  }

  #enqueue(subscriberId, event) {
    // Dedup: a given event_id may exist at most once per mailbox in any state.
    const existing = this.sql.exec('SELECT state FROM mailbox WHERE subscriber_id = ? AND event_id = ?', subscriberId, event.eventId).toArray();
    if (existing.length) return false;
    this.sql.exec(
      'INSERT INTO mailbox (subscriber_id, event_id, state, payload, claimed_at) VALUES (?, ?, ?, ?, NULL)',
      subscriberId, event.eventId, 'pending', JSON.stringify(event),
    );
    return true;
  }

  unsubscribe(subscriberId, ownerRunId) {
    assertId(subscriberId, 'subscriber id');
    const sub = this.#loadSubscriber(subscriberId);
    if (!sub) { const e = new Error('subscriber not found'); e.code = 'ENOENT'; throw e; }
    this.#assertOwner(sub, ownerRunId);
    this.sql.exec('DELETE FROM mailbox WHERE subscriber_id = ?', subscriberId);
    this.sql.exec('DELETE FROM subscribers WHERE subscriber_id = ?', subscriberId);
    return { subscriberId, unsubscribed: true };
  }

  async route(rawEvent) {
    const id = await deriveEventId(rawEvent, sha256Hex);
    const routed = sanitizeCallbackEvent({ ...rawEvent, eventId: id });
    if (!validTimestamp(routed.at)) throw new Error('invalid callback event timestamp');
    if (!TERMINAL_EVENT_TYPES.includes(routed.type) || typeof routed.runId !== 'string') {
      throw new Error('invalid callback event');
    }
    // Journal write is the dedup gate (event_id PRIMARY KEY).
    const already = this.sql.exec('SELECT 1 FROM journal WHERE event_id = ?', id).toArray();
    if (already.length) return { eventId: id, duplicate: true, delivered: 0 };
    this.sql.exec('INSERT INTO journal (event_id, payload, at) VALUES (?, ?, ?)', id, JSON.stringify(routed), routed.at);

    let delivered = 0;
    for (const row of this.sql.exec('SELECT * FROM subscribers').toArray()) {
      const sub = this.#rowToSubscriber(row);
      if (!matches(sub, routed)) continue;
      if (this.#enqueue(sub.subscriberId, routed)) delivered++;
    }
    return { eventId: id, duplicate: false, delivered };
  }

  claim({ subscriberId, limit = 20, ownerRunId } = {}) {
    const sub = this.getSubscriber(subscriberId);
    this.#assertOwner(sub, ownerRunId);
    const bounded = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = this.sql.exec(
      "SELECT event_id, payload FROM mailbox WHERE subscriber_id = ? AND state = 'pending' ORDER BY event_id ASC LIMIT ?",
      subscriberId, bounded,
    ).toArray();
    const events = [];
    const claimedAt = new Date().toISOString();
    for (const row of rows) {
      let parsed;
      try { parsed = JSON.parse(row.payload); } catch { continue; }
      if (!isValidCallbackEvent(parsed, row.event_id, { state: 'pending' })) continue;
      const event = { ...sanitizeCallbackEvent(parsed), claimedAt };
      this.sql.exec(
        "UPDATE mailbox SET state = 'inflight', payload = ?, claimed_at = ? WHERE subscriber_id = ? AND event_id = ?",
        JSON.stringify(event), claimedAt, subscriberId, row.event_id,
      );
      events.push(event);
    }
    return { subscriberId, events };
  }

  ack({ subscriberId, eventId: id, ownerRunId } = {}) {
    const sub = this.getSubscriber(subscriberId);
    this.#assertOwner(sub, ownerRunId);
    assertId(id, 'event id');
    const rows = this.sql.exec('SELECT state, payload FROM mailbox WHERE subscriber_id = ? AND event_id = ?', subscriberId, id).toArray();
    const row = rows[0];
    if (!row) throw new Error(`event is not inflight: ${id}`);
    if (row.state === 'acked') return { subscriberId, eventId: id, acknowledged: true, duplicate: true };
    if (row.state !== 'inflight') throw new Error(`event is not inflight: ${id}`);
    let event;
    try { event = JSON.parse(row.payload); } catch { throw new Error(`event is not inflight: ${id}`); }
    if (!isValidCallbackEvent(event, id, { state: 'claimed' })) throw new Error(`event is not inflight: ${id}`);
    this.sql.exec("UPDATE mailbox SET state = 'acked' WHERE subscriber_id = ? AND event_id = ?", subscriberId, id);
    return { subscriberId, eventId: id, acknowledged: true };
  }

  status(subscriberId, ownerRunId) {
    const sub = this.getSubscriber(subscriberId);
    this.#assertOwner(sub, ownerRunId);
    const count = (state, validState) => {
      let n = 0;
      for (const row of this.sql.exec('SELECT event_id, payload FROM mailbox WHERE subscriber_id = ? AND state = ?', subscriberId, state).toArray()) {
        let event; try { event = JSON.parse(row.payload); } catch { continue; }
        if (isValidCallbackEvent(event, row.event_id, { state: validState })) n++;
      }
      return n;
    };
    return {
      subscriberId,
      pending: count('pending', 'pending'),
      inflight: count('inflight', 'claimed'),
      acknowledged: count('acked', 'claimed'),
    };
  }

  requeue({ subscriberId, olderThanMs = 300000, ownerRunId } = {}) {
    const sub = this.getSubscriber(subscriberId);
    this.#assertOwner(sub, ownerRunId);
    const now = Date.now();
    const cutoff = Math.max(0, Number(olderThanMs) || 0);
    let requeued = 0;
    for (const row of this.sql.exec("SELECT event_id, payload FROM mailbox WHERE subscriber_id = ? AND state = 'inflight'", subscriberId).toArray()) {
      let event; try { event = JSON.parse(row.payload); } catch { continue; }
      if (!isValidCallbackEvent(event, row.event_id, { state: 'claimed' })) continue;
      if (now - Date.parse(event.claimedAt) < cutoff) continue;
      const pendingEvent = sanitizeCallbackEvent(event); // drops claimedAt
      this.sql.exec(
        "UPDATE mailbox SET state = 'pending', payload = ?, claimed_at = NULL WHERE subscriber_id = ? AND event_id = ?",
        JSON.stringify(pendingEvent), subscriberId, row.event_id,
      );
      requeued++;
    }
    return { subscriberId, requeued };
  }

  // ---- HTTP dispatch from the worker ----
  async fetch(request) {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const { op, args = {} } = body;
    try {
      let result;
      switch (op) {
        case 'subscribe': result = await this.subscribe(args); break;
        case 'getSubscriber': result = this.getSubscriber(args.subscriberId); break;
        case 'unsubscribe': result = this.unsubscribe(args.subscriberId, args.ownerRunId); break;
        case 'route': result = await this.route(args.event ?? args); break;
        case 'claim': result = this.claim(args); break;
        case 'ack': result = this.ack(args); break;
        case 'status': result = this.status(args.subscriberId, args.ownerRunId); break;
        case 'requeue': result = this.requeue(args); break;
        default: return Response.json({ ok: false, error: 'unknown op' }, { status: 400 });
      }
      return Response.json({ ok: true, result });
    } catch (error) {
      const denied = /access denied|owned by another/.test(error.message);
      const notFound = error.code === 'ENOENT';
      const status = denied ? 403 : notFound ? 404 : 400;
      return Response.json({ ok: false, error: error.message }, { status });
    }
  }
}
