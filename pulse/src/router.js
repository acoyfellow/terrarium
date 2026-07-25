import { matches, normalizeEvent } from './schema.js';

const key = (subscriberId, eventId) => `${subscriberId}\0${eventId}`;

function normalizeSubscriber(args = {}) {
  return {
    subscriberId: args.subscriberId,
    owner: args.owner || args.ownerRunId || 'local',
    filters: {
      ...(args.filters || {}),
      channels: args.channels ?? args.filters?.channels,
      runIds: args.runIds ?? args.filters?.runIds,
      subjectIds: args.subjectIds ?? args.filters?.subjectIds,
    },
    updatedAt: Date.now(),
  };
}

export class PulseRouter {
  constructor() {
    this.journal = new Map();
    this.subscribers = new Map();
    this.mailbox = new Map();
  }

  async subscribe(args = {}) {
    if (!args.subscriberId) throw new Error('subscriberId required');
    const existing = this.subscribers.get(args.subscriberId);
    const next = normalizeSubscriber(args);
    if (existing && existing.owner !== next.owner) throw new Error('owned by another');
    this.subscribers.set(next.subscriberId, next);
    let replayed = 0;
    const concrete = Array.isArray(next.filters.runIds) || Array.isArray(next.filters.subjectIds);
    if (concrete) {
      for (const event of this.journal.values()) {
        if (matches(event, next)) {
          this.mailbox.set(key(next.subscriberId, event.eventId), { subscriberId: next.subscriberId, eventId: event.eventId, state: 'pending', attempts: 0, updatedAt: Date.now() });
          replayed++;
        }
      }
    }
    return { subscriberId: next.subscriberId, replayed };
  }

  emit(input = {}) { return this.route(input); }

  route(input = {}) {
    const event = normalizeEvent(input);
    const duplicate = this.journal.has(event.eventId);
    if (!duplicate) this.journal.set(event.eventId, event);
    let delivered = 0;
    if (!duplicate) {
      for (const sub of this.subscribers.values()) {
        if (matches(event, sub)) {
          const k = key(sub.subscriberId, event.eventId);
          if (!this.mailbox.has(k)) {
            this.mailbox.set(k, { subscriberId: sub.subscriberId, eventId: event.eventId, state: 'pending', attempts: 0, updatedAt: Date.now() });
            delivered++;
          }
        }
      }
    }
    return { eventId: event.eventId, duplicate, delivered };
  }

  claim(args = {}) {
    const sub = this.subscribers.get(args.subscriberId);
    if (!sub) return { events: [], quarantined: 0 };
    this.#assertOwner(sub, args.owner || args.ownerRunId || 'local');
    const limit = Math.max(1, Math.min(Number(args.limit || 20), 100));
    const maxDeliveryAttempts = args.maxDeliveryAttempts == null ? Infinity : Number(args.maxDeliveryAttempts);
    const events = [];
    let quarantined = 0;
    for (const row of this.mailbox.values()) {
      if (row.subscriberId !== args.subscriberId || row.state !== 'pending') continue;
      if (row.attempts >= maxDeliveryAttempts) {
        row.state = 'dead';
        row.updatedAt = Date.now();
        quarantined++;
        continue;
      }
      if (events.length >= limit) break;
      row.state = 'inflight';
      row.updatedAt = Date.now();
      events.push({ ...this.journal.get(row.eventId), claimedAt: new Date(row.updatedAt).toISOString(), deliveryAttempts: row.attempts });
    }
    return { events, quarantined };
  }

  ack(args = {}) {
    const row = this.mailbox.get(key(args.subscriberId, args.eventId));
    if (!row) return { acknowledged: false };
    if (row.state === 'acked') return { acknowledged: true, duplicate: true };
    if (row.state !== 'inflight') throw new Error('not inflight');
    row.state = 'acked';
    row.updatedAt = Date.now();
    return { acknowledged: true };
  }

  requeue(args = {}) {
    let requeued = 0;
    let maxAttempts = 0;
    const olderThanMs = Number(args.olderThanMs ?? 300000);
    const now = Date.now();
    for (const row of this.mailbox.values()) {
      if (row.subscriberId === args.subscriberId && row.state === 'inflight' && now - row.updatedAt >= olderThanMs) {
        row.state = 'pending';
        row.attempts++;
        row.updatedAt = now;
        requeued++;
      }
      maxAttempts = Math.max(maxAttempts, row.attempts || 0);
    }
    return { requeued, maxAttempts };
  }

  status(args = {}, ownerMaybe) {
    const subscriberId = typeof args === 'string' ? args : args.subscriberId;
    if (subscriberId) {
      const sub = this.subscribers.get(subscriberId);
      if (sub) this.#assertOwner(sub, ownerMaybe || (typeof args === 'object' ? args.owner || args.ownerRunId : undefined) || sub.owner);
    }
    const counts = subscriberId
      ? { subscriberId, pending: 0, inflight: 0, acknowledged: 0, dead: 0 }
      : { pending: 0, inflight: 0, acknowledged: 0, dead: 0, journal: this.journal.size, subscribers: this.subscribers.size };
    for (const row of this.mailbox.values()) {
      if (!subscriberId || row.subscriberId === subscriberId) {
        if (row.state === 'acked') counts.acknowledged++;
        else counts[row.state]++;
      }
    }
    return counts;
  }

  prune() {
    let acknowledgedRemoved = 0;
    for (const [k, row] of this.mailbox.entries()) {
      if (row.state === 'acked') { this.mailbox.delete(k); acknowledgedRemoved++; }
    }
    const liveEventIds = new Set([...this.mailbox.values()].map(r => r.eventId));
    let journalRemoved = 0;
    for (const eventId of [...this.journal.keys()]) {
      if (!liveEventIds.has(eventId)) { this.journal.delete(eventId); journalRemoved++; }
    }
    return { acknowledgedRemoved, journalRemoved, subscribersRemoved: 0 };
  }

  getSubscriber(subscriberId) { return this.subscribers.get(subscriberId); }
  unsubscribe(subscriberId) { return { removed: this.subscribers.delete(subscriberId) }; }

  #assertOwner(sub, owner) {
    if (sub.owner !== (owner || 'local')) throw new Error('access denied');
  }
}

export function createPulseRouter() {
  return new PulseRouter();
}
