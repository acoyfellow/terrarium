// Pure, runtime-agnostic helpers shared by the fs router (src/router.js) and the
// Cloudflare pulse backend (src/pulse/do.js). No node:fs / node:os imports here so
// this module loads cleanly inside a Cloudflare Worker / Durable Object.
//
// These mirror the exact validation semantics of the fs router so both backends
// accept and emit byte-identical callback event shapes.

export const TERMINAL_EVENT_TYPES = ['Completed', 'Failed', 'TimedOut', 'Cancelled'];

export const CALLBACK_EVENT_KEYS = new Set([
  'type', 'eventId', 'runId', 'parentRunId', 'taskFingerprint', 'workflowId',
  'sessionId', 'channel', 'at', 'status', 'ok', 'exitCode', 'signal', 'dryRun',
]);
export const CLAIMED_CALLBACK_EVENT_KEYS = new Set([...CALLBACK_EVENT_KEYS, 'claimedAt']);

const ALLOWED_EVENT_FIELDS = [
  'type', 'eventId', 'runId', 'parentRunId', 'taskFingerprint', 'workflowId',
  'sessionId', 'channel', 'at', 'status', 'ok', 'exitCode', 'signal', 'dryRun',
];

export function assertId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

export function boundedList(value, fallback = ['*']) {
  const list = value ?? fallback;
  if (!Array.isArray(list) || list.length < 1 || list.length > 100 ||
      list.some((item) => typeof item !== 'string' || item.length > 200)) {
    throw new Error('invalid subscription filter');
  }
  return [...new Set(list)];
}

// Deterministic event id derivation. Must match src/router.js exactly so an event
// routed through either backend collapses to the same id (dedup parity).
export async function eventId(event, sha256Hex) {
  if (event.eventId) return assertId(event.eventId, 'event id');
  const payload = JSON.stringify([event.runId, event.type, event.at, event.status, event.exitCode]);
  return `evt_${(await sha256Hex(payload)).slice(0, 32)}`;
}

export function sanitizeCallbackEvent(event) {
  return Object.fromEntries(
    ALLOWED_EVENT_FIELDS.filter((key) => event[key] !== undefined).map((key) => [key, event[key]]),
  );
}

export function validTimestamp(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value;
}

export function isValidCallbackEvent(event, expectedEventId, { state = 'any' } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (event.eventId !== expectedEventId || !TERMINAL_EVENT_TYPES.includes(event.type) || typeof event.runId !== 'string') return false;
  const claimed = Object.hasOwn(event, 'claimedAt');
  if (state === 'pending' && claimed) return false;
  if (state === 'claimed' && !claimed) return false;
  const allowed = claimed ? CLAIMED_CALLBACK_EVENT_KEYS : CALLBACK_EVENT_KEYS;
  return Object.keys(event).every((key) => allowed.has(key)) && validTimestamp(event.at) && (!claimed || validTimestamp(event.claimedAt));
}

// Subscription <-> event matching, identical to the fs router including the
// pi-*/pi_* wildcard guard that prevents waking sibling Pi sessions.
export function matches(subscription, event) {
  const channels = subscription.channels ?? ['*'];
  const workflows = subscription.workflowIds ?? ['*'];
  const types = subscription.eventTypes ?? ['*'];
  const runs = subscription.runIds ?? ['*'];
  if (/^pi[-_]/.test(subscription.subscriberId || '') && runs.includes('*')) return false;
  return (channels.includes('*') || channels.includes(event.channel)) &&
    (workflows.includes('*') || workflows.includes(event.workflowId)) &&
    (types.includes('*') || types.includes(event.type)) &&
    (runs.includes('*') || runs.includes(event.runId));
}

// Filter-merge semantics for re-subscription, lifted verbatim from the fs router.
export function mergeFilters(requested, prior, fallback, { narrowWildcard = false } = {}) {
  const next = boundedList(requested, fallback);
  if (!prior) return next;
  const previous = boundedList(prior, fallback);
  if (next.includes('*')) return ['*'];
  if (previous.includes('*')) return narrowWildcard ? next : ['*'];
  return [...new Set([...previous, ...next])];
}
