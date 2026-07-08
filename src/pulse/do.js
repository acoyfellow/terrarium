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

// Allowed top-level keys on a stored subscriber record. Mirrors src/router.js
// getSubscriber exactly so a record persisted by either backend validates the
// same way and a tampered/extra-field record fails closed before owner checks.
//
// Round 5C2: adds principalId as the durable owner of a production subscriber.
// principalId is the stable Cloud Terrarium principal identity from
// TERRARIUM_PRINCIPAL_ID; unlike ownerRunId (a per-run scope kept for parity
// with the fs router record shape), it survives across many runs of the same
// caller and is the *only* dimension the public worker uses to isolate
// mailboxes and route fan-out.
const SUBSCRIBER_RECORD_KEYS = new Set([
  'version', 'subscriberId', 'channels', 'workflowIds', 'eventTypes', 'runIds',
  'ownerRunId', 'principalId', 'createdAt', 'updatedAt',
]);
const OWNER_RUN_ID_RE = /^ter_[A-Za-z0-9_]+$/;
const PRINCIPAL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ownerOrNull(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !OWNER_RUN_ID_RE.test(value)) throw new Error('invalid subscriber owner run id');
  return value;
}

function principalOrNull(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !PRINCIPAL_ID_RE.test(value)) throw new Error('invalid subscriber principal');
  return value;
}

// Round 5C2: a "not found" that the worker normalizes to a generic 404 so a
// probing caller cannot enumerate the subscriber space.
function notFoundError(message) {
  const err = new Error(message || 'subscriber not found');
  err.code = 'ENOENT';
  return err;
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
      principal_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    // Round 5C2: idempotent principal_id migration for tables created before
    // this round. PRAGMA is used to detect the column; adding it is safe even
    // on legacy rows (existing rows will have NULL principal_id and can only
    // be used from the internal DO surface, never re-adopted from the public
    // worker without a matching principalId subscribe).
    try {
      const info = this.sql.exec('PRAGMA table_info(subscribers)');
      const rows = info.toArray ? info.toArray() : [...info];
      const hasCol = rows.some((r) => (r.name || r[1]) === 'principal_id');
      if (!hasCol) this.sql.exec('ALTER TABLE subscribers ADD COLUMN principal_id TEXT');
    } catch { /* older SQL shims may not support PRAGMA; new column exists in CREATE */ }
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
      principalId: row.principal_id ?? null,
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
    if (!sub) throw notFoundError('subscriber not found');
    // Validate the stored record before any owner/access check, identical to the
    // fs router (src/router.js getSubscriber). A row whose JSON-decoded shape
    // carries non-allowlisted keys, a malformed ownerRunId, or non-ISO
    // createdAt/updatedAt fails closed rather than leaking access. #rowToSubscriber
    // only ever projects allowlisted columns, so this primarily guards against a
    // corrupt/tampered owner_run_id or timestamp written into the table.
    if (sub.subscriberId !== subscriberId ||
        !Object.keys(sub).every((key) => SUBSCRIBER_RECORD_KEYS.has(key)) ||
        !Object.hasOwn(sub, 'ownerRunId') ||
        (sub.ownerRunId !== null && !OWNER_RUN_ID_RE.test(sub.ownerRunId)) ||
        (sub.principalId !== null && sub.principalId !== undefined && !PRINCIPAL_ID_RE.test(sub.principalId)) ||
        !validTimestamp(sub.createdAt) ||
        !validTimestamp(sub.updatedAt)) {
      throw new Error('invalid callback subscriber record');
    }
    return sub;
  }

  #assertOwner(subscription, ownerRunId) {
    const stored = subscription.ownerRunId ?? null;
    if (stored !== (ownerRunId ?? null)) throw new Error('callback subscriber access denied');
  }

  // Round 5C2: enforce exact principal match on every access. Cross-principal
  // and missing-principal accesses are normalized to a generic not-found by
  // the worker (anti-enumeration). A subscriber with no principal_id (legacy
  // internal-only row) cannot be adopted by any authenticated principal.
  #assertPrincipal(subscription, principalId) {
    if (principalId == null) return; // internal (DO-only) callers bypass this check
    const stored = subscription.principalId ?? null;
    if (stored !== principalId) throw notFoundError('subscriber not found');
  }

  async subscribe(subscription) {
    const subscriberId = assertId(subscription.subscriberId, 'subscriber id');
    const requestedOwner = ownerOrNull(subscription.ownerRunId);
    const requestedPrincipal = principalOrNull(subscription.principalId);
    const existing = this.#loadSubscriber(subscriberId);
    // Check stable-principal ownership before legacy ownerRunId so a
    // cross-principal re-subscribe cannot distinguish an existing ID by
    // varying ownerRunId.
    if (existing && (existing.principalId ?? null) !== (requestedPrincipal ?? existing.principalId ?? null)) {
      throw notFoundError('subscriber not found');
    }
    if (existing && (existing.ownerRunId ?? null) !== requestedOwner) {
      // Direct legacy/test callers may still use ownerRunId, but the public
      // worker strips it and normalizes this response.
      throw new Error('subscriber is owned by another run or controller');
    }
    const ownerRunId = requestedOwner ?? existing?.ownerRunId ?? null;
    const principalId = requestedPrincipal ?? existing?.principalId ?? null;
    const now = new Date().toISOString();
    const normalized = {
      version: 1,
      subscriberId,
      channels: mergeFilters(subscription.channels, existing?.channels, ['*']),
      workflowIds: mergeFilters(subscription.workflowIds, existing?.workflowIds, ['*']),
      eventTypes: mergeFilters(subscription.eventTypes, existing?.eventTypes, TERMINAL_EVENT_TYPES),
      runIds: mergeFilters(subscription.runIds, existing?.runIds, ['*'], { narrowWildcard: subscription.narrowWildcardRunIds === true }),
      ownerRunId,
      principalId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sql.exec(
      `INSERT INTO subscribers (subscriber_id, channels, workflow_ids, event_types, run_ids, owner_run_id, principal_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subscriber_id) DO UPDATE SET
         channels=excluded.channels, workflow_ids=excluded.workflow_ids,
         event_types=excluded.event_types, run_ids=excluded.run_ids,
         owner_run_id=excluded.owner_run_id, principal_id=excluded.principal_id,
         updated_at=excluded.updated_at`,
      subscriberId,
      JSON.stringify(normalized.channels),
      JSON.stringify(normalized.workflowIds),
      JSON.stringify(normalized.eventTypes),
      JSON.stringify(normalized.runIds),
      normalized.ownerRunId,
      normalized.principalId,
      normalized.createdAt,
      normalized.updatedAt,
    );

    // Replay: only concrete (non-wildcard) run subscriptions replay journal history.
    // Match against the *requested* filters (not merged) like the fs router.
    // Round 5C2: replay only fans events whose event.ownerId matches this
    // subscriber's principalId (when the subscriber has one).
    const requestedRuns = boundedList(subscription.runIds);
    const replayed = requestedRuns.includes('*') ? 0 : this.#replay({
      subscriberId,
      channels: boundedList(subscription.channels),
      workflowIds: boundedList(subscription.workflowIds),
      eventTypes: boundedList(subscription.eventTypes, TERMINAL_EVENT_TYPES),
      runIds: requestedRuns,
      principalId,
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
      // Round 5C2: replay cross-principal isolation. A subscriber owned by a
      // principal must never enqueue an event whose ownerId belongs to
      // another principal.
      const subPrincipal = requestedSubscription.principalId ?? null;
      const eventOwner = event.ownerId ?? null;
      if (subPrincipal !== null && eventOwner !== subPrincipal) continue;
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

  unsubscribe(subscriberId, ownerRunId, principalId) {
    assertId(subscriberId, 'subscriber id');
    const sub = this.getSubscriber(subscriberId);
    this.#assertPrincipal(sub, principalId);
    this.#assertOwner(sub, ownerRunId);
    this.sql.exec('DELETE FROM mailbox WHERE subscriber_id = ?', subscriberId);
    this.sql.exec('DELETE FROM subscribers WHERE subscriber_id = ?', subscriberId);
    return { subscriberId, unsubscribed: true };
  }

  async route(rawEvent, { requirePrincipalOwner = false } = {}) {
    const id = await deriveEventId(rawEvent, sha256Hex);
    const routed = sanitizeCallbackEvent({ ...rawEvent, eventId: id });
    if (!validTimestamp(routed.at)) throw new Error('invalid callback event timestamp');
    if (!TERMINAL_EVENT_TYPES.includes(routed.type) || typeof routed.runId !== 'string') {
      throw new Error('invalid callback event');
    }
    // Round 5C2: production Cloud routing REQUIRES a well-formed event.ownerId
    // (the principal that owns the run). Internal DO-only test paths can opt
    // out via requirePrincipalOwner=false, but the worker always passes true.
    if (requirePrincipalOwner) {
      if (typeof routed.ownerId !== 'string' || !PRINCIPAL_ID_RE.test(routed.ownerId)) {
        throw new Error('invalid callback event');
      }
    }
    // Journal write is the dedup gate (event_id PRIMARY KEY).
    const already = this.sql.exec('SELECT payload FROM journal WHERE event_id = ?', id).toArray();
    if (already.length) {
      let prior;
      try { prior = JSON.parse(already[0].payload); } catch { throw new Error('invalid callback journal record'); }
      // A stable eventId may only be retried by the same principal. Otherwise
      // the global dedup key becomes a cross-principal existence oracle.
      if ((prior.ownerId ?? null) !== (routed.ownerId ?? null)) throw notFoundError('event not found');
      return { eventId: id, duplicate: true, delivered: 0 };
    }
    this.sql.exec('INSERT INTO journal (event_id, payload, at) VALUES (?, ?, ?)', id, JSON.stringify(routed), routed.at);

    // Round 5C2: fan-out isolation. matches() still fans purely by filter
    // (channels/workflowIds/eventTypes/runIds + pi-* wildcard guard), but on
    // the Cloud production path we additionally enforce cross-principal
    // isolation: an event may only enqueue into subscriber mailboxes whose
    // principalId is EXACTLY event.ownerId. Same-principal wildcard
    // subscribers receive all that principal's runs; subscribers owned by a
    // different principal are skipped even if their filters would match.
    // Subscribers with a null principal_id are legacy internal-only rows that
    // never receive owner-tagged events.
    let delivered = 0;
    for (const row of this.sql.exec('SELECT * FROM subscribers').toArray()) {
      const sub = this.#rowToSubscriber(row);
      if (!matches(sub, routed)) continue;
      const subPrincipal = sub.principalId ?? null;
      const eventOwner = routed.ownerId ?? null;
      // Owner-tagged events only fan to same-principal subscribers.
      if (eventOwner !== null && subPrincipal !== eventOwner) continue;
      // Non-owner-tagged events (internal DO path) only fan to null-principal
      // subscribers (also internal-only). This prevents a principal-owned
      // subscriber from receiving an untagged event.
      if (eventOwner === null && subPrincipal !== null) continue;
      if (this.#enqueue(sub.subscriberId, routed)) delivered++;
    }
    return { eventId: id, duplicate: false, delivered };
  }

  claim({ subscriberId, limit = 20, maxDeliveryAttempts, ownerRunId, principalId } = {}) {
    const sub = this.getSubscriber(subscriberId);
    this.#assertPrincipal(sub, principalId);
    this.#assertOwner(sub, ownerRunId);
    const bounded = Math.min(Math.max(Number(limit) || 20, 1), 100);
    // maxDeliveryAttempts caps poison-event redelivery, mirroring the fs router:
    // a pending row whose recorded deliveryAttempts already reached the cap is
    // moved to the 'dead' state instead of being re-served, so a consumer that
    // keeps crashing on it stops looping while the row stays inspectable.
    const cap = Number.isInteger(maxDeliveryAttempts) && maxDeliveryAttempts > 0 ? maxDeliveryAttempts : null;
    // Scan enough rows to fill the claim limit even if some are quarantined.
    const rows = this.sql.exec(
      "SELECT event_id, payload FROM mailbox WHERE subscriber_id = ? AND state = 'pending' ORDER BY event_id ASC LIMIT ?",
      subscriberId, cap ? Math.min(bounded + 100, 200) : bounded,
    ).toArray();
    const events = [];
    let quarantined = 0;
    const claimedAt = new Date().toISOString();
    for (const row of rows) {
      if (events.length >= bounded) break;
      let parsed;
      try { parsed = JSON.parse(row.payload); } catch { continue; }
      if (!isValidCallbackEvent(parsed, row.event_id, { state: 'pending' })) continue;
      const attempts = Number.isInteger(parsed.deliveryAttempts) ? parsed.deliveryAttempts : 0;
      if (cap && attempts >= cap) {
        // Quarantine: keep the pending-shape payload (no claimedAt) under 'dead'.
        this.sql.exec(
          "UPDATE mailbox SET state = 'dead', claimed_at = NULL WHERE subscriber_id = ? AND event_id = ?",
          subscriberId, row.event_id,
        );
        quarantined++;
        continue;
      }
      const event = { ...sanitizeCallbackEvent(parsed), claimedAt };
      this.sql.exec(
        "UPDATE mailbox SET state = 'inflight', payload = ?, claimed_at = ? WHERE subscriber_id = ? AND event_id = ?",
        JSON.stringify(event), claimedAt, subscriberId, row.event_id,
      );
      events.push(event);
    }
    return { subscriberId, events, quarantined };
  }

  ack({ subscriberId, eventId: id, ownerRunId, principalId } = {}) {
    const sub = this.getSubscriber(subscriberId);
    this.#assertPrincipal(sub, principalId);
    this.#assertOwner(sub, ownerRunId);
    assertId(id, 'event id');
    const rows = this.sql.exec('SELECT state, payload FROM mailbox WHERE subscriber_id = ? AND event_id = ?', subscriberId, id).toArray();
    const row = rows[0];
    if (!row) throw notFoundError(`event is not inflight: ${id}`);
    if (row.state === 'acked') return { subscriberId, eventId: id, acknowledged: true, duplicate: true };
    if (row.state !== 'inflight') throw notFoundError(`event is not inflight: ${id}`);
    let event;
    try { event = JSON.parse(row.payload); } catch { throw new Error(`event is not inflight: ${id}`); }
    if (!isValidCallbackEvent(event, id, { state: 'claimed' })) throw new Error(`event is not inflight: ${id}`);
    this.sql.exec("UPDATE mailbox SET state = 'acked' WHERE subscriber_id = ? AND event_id = ?", subscriberId, id);
    return { subscriberId, eventId: id, acknowledged: true };
  }

  status(subscriberId, ownerRunId, principalId) {
    const sub = this.getSubscriber(subscriberId);
    this.#assertPrincipal(sub, principalId);
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
      dead: count('dead', 'pending'),
    };
  }

  // Garbage-collect bounded mailbox/journal/subscriber rows, mirroring the fs
  // router pruneRouter (src/router.js). Without this the journal + acked mailbox
  // rows accumulate forever inside the DO's SQLite, which is a long-running
  // reliability hazard. Semantics are byte-for-byte parity with the fs router:
  //   - per-subscriber, owner-scoped: a prune for ownerRunId X never touches a
  //     mailbox/subscriber owned by anyone else (children stay isolated).
  //   - acked rows age out by acknowledgedOlderThanMs (age from claimedAt||at).
  //   - pending/inflight rows age out by callbackOlderThanMs (age from claimedAt||at).
  //   - journal rows age out by journalOlderThanMs (age from event.at).
  //   - subscribers age out by subscriberOlderThanMs (age from createdAt) ONLY
  //     when they hold no pending/inflight events.
  //   - optional subscriberIds / eventIds narrow the sweep.
  prune({
    acknowledgedOlderThanMs = 7 * 86400000,
    journalOlderThanMs = 7 * 86400000,
    callbackOlderThanMs = 7 * 86400000,
    subscriberOlderThanMs = 7 * 86400000,
    subscriberIds,
    eventIds,
    ownerRunId,
    principalId,
  } = {}) {
    const owner = ownerRunId ?? null;
    const principal = principalId ?? null;
    const now = Date.now();
    const ackCutoff = Math.max(0, Number(acknowledgedOlderThanMs) || 0);
    const callbackCutoff = Math.max(0, Number(callbackOlderThanMs) || 0);
    const journalCutoff = Math.max(0, Number(journalOlderThanMs) || 0);
    const subscriberCutoff = Math.max(0, Number(subscriberOlderThanMs) || 0);
    const subscriberFilter = Array.isArray(subscriberIds) ? subscriberIds : null;
    const eventFilter = Array.isArray(eventIds) ? eventIds : null;
    // Mirrors fs router eventAge: prefer claimedAt for claimed mailbox rows, else
    // the event timestamp; a missing/unparseable stamp is treated as infinitely
    // old so corrupt rows are eligible for cleanup.
    const eventAge = (event) => {
      const ts = Date.parse(event.claimedAt || event.at || '');
      return Number.isFinite(ts) ? now - ts : Infinity;
    };
    let acknowledgedRemoved = 0, pendingRemoved = 0, inflightRemoved = 0, deadRemoved = 0, journalRemoved = 0, subscribersRemoved = 0;

    for (const row of this.sql.exec('SELECT subscriber_id FROM subscribers').toArray()) {
      const subscriberId = row.subscriber_id;
      if (subscriberFilter && !subscriberFilter.includes(subscriberId)) continue;
      let subscription; try { subscription = this.getSubscriber(subscriberId); } catch { continue; }
      // Owner isolation: a top-level prune maintains only its own mailboxes and
      // must never abort early or reach another owner's data. Round 5C2: the
      // principal dimension is required for the public worker path.
      if ((subscription.ownerRunId ?? null) !== owner) continue;
      if (principal !== null && (subscription.principalId ?? null) !== principal) continue;
      for (const [state, validState, cutoff] of [
        ['acked', 'claimed', ackCutoff],
        ['pending', 'pending', callbackCutoff],
        ['inflight', 'claimed', callbackCutoff],
        // Quarantined poison callbacks carry the pending shape and expire on the
        // callback cutoff, same as the fs router dead-letter sweep.
        ['dead', 'pending', callbackCutoff],
      ]) {
        for (const mrow of this.sql.exec('SELECT event_id, payload FROM mailbox WHERE subscriber_id = ? AND state = ?', subscriberId, state).toArray()) {
          if (eventFilter && !eventFilter.includes(mrow.event_id)) continue;
          let event; try { event = JSON.parse(mrow.payload); } catch { continue; }
          if (!isValidCallbackEvent(event, mrow.event_id, { state: validState })) continue;
          if (eventAge(event) < cutoff) continue;
          this.sql.exec('DELETE FROM mailbox WHERE subscriber_id = ? AND event_id = ?', subscriberId, mrow.event_id);
          if (state === 'acked') acknowledgedRemoved++;
          else if (state === 'pending') pendingRemoved++;
          else if (state === 'inflight') inflightRemoved++;
          else deadRemoved++;
        }
      }
    }

    for (const jrow of this.sql.exec('SELECT event_id, payload FROM journal').toArray()) {
      if (eventFilter && !eventFilter.includes(jrow.event_id)) continue;
      let event; try { event = JSON.parse(jrow.payload); } catch { continue; }
      if (!isValidCallbackEvent(event, jrow.event_id, { state: 'pending' })) continue;
      // Round 5C2: journal is shared; a principal-scoped prune must only
      // touch journal entries whose event.ownerId matches this principal.
      if (principal !== null && (event.ownerId ?? null) !== principal) continue;
      const age = now - Date.parse(event.at || '');
      if (!Number.isFinite(age) || age < journalCutoff) continue;
      this.sql.exec('DELETE FROM journal WHERE event_id = ?', jrow.event_id);
      journalRemoved++;
    }

    for (const row of this.sql.exec('SELECT subscriber_id FROM subscribers').toArray()) {
      const subscriberId = row.subscriber_id;
      if (subscriberFilter && !subscriberFilter.includes(subscriberId)) continue;
      let subscription; try { subscription = this.getSubscriber(subscriberId); } catch { continue; }
      if ((subscription.ownerRunId ?? null) !== owner) continue;
      if (principal !== null && (subscription.principalId ?? null) !== principal) continue;
      const age = now - Date.parse(subscription.createdAt || '');
      if (!Number.isFinite(age) || age < subscriberCutoff) continue;
      const st = this.status(subscriberId, subscription.ownerRunId, subscription.principalId ?? null);
      // Keep a subscriber alive while it still holds quarantined poison events.
      if (st.pending || st.inflight || st.dead) continue;
      this.sql.exec('DELETE FROM mailbox WHERE subscriber_id = ?', subscriberId);
      this.sql.exec('DELETE FROM subscribers WHERE subscriber_id = ?', subscriberId);
      subscribersRemoved++;
    }

    return { acknowledgedRemoved, pendingRemoved, inflightRemoved, deadRemoved, journalRemoved, subscribersRemoved };
  }

  requeue({ subscriberId, olderThanMs = 300000, ownerRunId, principalId } = {}) {
    const sub = this.getSubscriber(subscriberId);
    this.#assertPrincipal(sub, principalId);
    this.#assertOwner(sub, ownerRunId);
    const now = Date.now();
    const cutoff = Math.max(0, Number(olderThanMs) || 0);
    let requeued = 0;
    // maxAttempts mirrors the fs router: the most-redelivered event in this pass
    // so operators can spot a poison event a consumer keeps crashing on.
    let maxAttempts = 0;
    for (const row of this.sql.exec("SELECT event_id, payload FROM mailbox WHERE subscriber_id = ? AND state = 'inflight'", subscriberId).toArray()) {
      let event; try { event = JSON.parse(row.payload); } catch { continue; }
      if (!isValidCallbackEvent(event, row.event_id, { state: 'claimed' })) continue;
      if (now - Date.parse(event.claimedAt) < cutoff) continue;
      // sanitizeCallbackEvent drops claimedAt; bump the redelivery counter so the
      // re-pending event records that it has now been delivered one more time.
      const attempts = (Number.isInteger(event.deliveryAttempts) ? event.deliveryAttempts : 0) + 1;
      const pendingEvent = { ...sanitizeCallbackEvent(event), deliveryAttempts: attempts };
      this.sql.exec(
        "UPDATE mailbox SET state = 'pending', payload = ?, claimed_at = NULL WHERE subscriber_id = ? AND event_id = ?",
        JSON.stringify(pendingEvent), subscriberId, row.event_id,
      );
      requeued++;
      if (attempts > maxAttempts) maxAttempts = attempts;
    }
    return { subscriberId, requeued, maxAttempts };
  }

  // ---- HTTP dispatch from the worker ----
  async fetch(request) {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const { op, args = {}, requirePrincipalOwner } = body;
    try {
      // Every mailbox/subscriber operation reaching the production DO fetch
      // surface requires a bounded principal. Direct method calls remain only
      // for legacy parity tests. Internal RunControl uses only `route`.
      if (op !== 'route' && principalOrNull(args.principalId) === null) {
        throw new Error('principal is required');
      }
      let result;
      switch (op) {
        case 'subscribe': result = await this.subscribe(args); break;
        case 'getSubscriber': {
          const sub = this.getSubscriber(args.subscriberId);
          this.#assertPrincipal(sub, args.principalId ?? null);
          this.#assertOwner(sub, args.ownerRunId);
          result = sub;
          break;
        }
        case 'unsubscribe': result = this.unsubscribe(args.subscriberId, args.ownerRunId, args.principalId ?? null); break;
        case 'route': result = await this.route(args.event ?? args, { requirePrincipalOwner: !!requirePrincipalOwner }); break;
        case 'claim': result = this.claim(args); break;
        case 'ack': result = this.ack(args); break;
        case 'status': result = this.status(args.subscriberId, args.ownerRunId, args.principalId ?? null); break;
        case 'requeue': result = this.requeue(args); break;
        case 'prune': result = this.prune(args); break;
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
