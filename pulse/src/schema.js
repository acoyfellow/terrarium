export const TERMINAL_TYPES = new Set(['Completed', 'Failed', 'Cancelled', 'TimedOut']);
export const ALLOWED_EVENT_FIELDS = new Set(['eventId','source','subjectId','runId','parentRunId','type','status','ok','exitCode','signal','at','channel','workflowId','taskFingerprint','receipt','evidenceRef','claimedAt','deliveryAttempts']);

export function assertString(name, value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
}

export function assertId(value, name = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.*:-]{1,128}$/.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

export function validTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function boundedList(value, max = 100) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max || !value.every(v => typeof v === 'string' && v.length > 0)) throw new Error('invalid subscription filter');
  return [...new Set(value)];
}

export function sanitizeEvent(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input)) if (ALLOWED_EVENT_FIELDS.has(k)) out[k] = v;
  return out;
}

export async function deriveEventId(event = {}) { return eventId(event); }

export function eventId(event = {}) {
  if (event.eventId) return assertId(event.eventId, 'eventId');
  const subjectId = event.subjectId ?? event.runId;
  const payload = JSON.stringify([event.source ?? 'pulse.docs', subjectId, event.type, event.at, event.status, event.exitCode]);
  return `evt_${stableHex(payload)}`;
}

export function normalizeEvent(input) {
  const event = sanitizeEvent({ ...input });
  event.source ||= 'pulse.docs';
  event.subjectId ||= event.runId;
  event.runId ||= event.subjectId;
  event.owner ||= event.ownerRunId || 'local';
  event.status ||= event.type === 'Failed' ? 'failed' : 'done';
  event.at ||= new Date().toISOString();
  assertString('source', event.source);
  assertString('subjectId', event.subjectId);
  assertString('type', event.type);
  assertString('status', event.status);
  if (!TERMINAL_TYPES.has(event.type)) throw new Error(`invalid callback event: type must be terminal: ${[...TERMINAL_TYPES].join(', ')}`);
  event.eventId ||= eventId(event);
  return event;
}

export function isValidEvent(event = {}, expectedEventId, opts = {}) {
  if (!event || typeof event !== 'object') return false;
  if (Object.keys(event).some(k => !ALLOWED_EVENT_FIELDS.has(k))) return false;
  if (!TERMINAL_TYPES.has(event.type)) return false;
  if (event.at && !validTimestamp(event.at)) return false;
  if (expectedEventId && event.eventId !== expectedEventId) return false;
  if (opts.state === 'pending' && event.claimedAt) return false;
  if (opts.state === 'claimed' && !event.claimedAt) return false;
  return true;
}

export function matches(a, b) {
  // Supports both shapes: matches(event, subscriber) and matches(filters, event).
  const eventFirst = a && (a.type || a.subjectId || a.runId || a.source) && b && (b.filters || b.subscriberId);
  const event = eventFirst ? a : b;
  const sub = eventFirst ? b : { subscriberId: a?.subscriberId, filters: a || {} };
  const filters = sub.filters || {};
  const subject = event.subjectId ?? event.runId;
  const runFilters = filters.subjectIds ?? filters.runIds;
  if (/^pi[-_]/.test(sub.subscriberId || '') && Array.isArray(runFilters) && runFilters.includes('*')) return false;
  return listMatch(filters.sources, event.source)
    && listMatch(runFilters, subject)
    && listMatch(filters.channels, event.channel)
    && listMatch(filters.workflowIds, event.workflowId)
    && listMatch(filters.types, event.type)
    && listMatch(filters.statuses, event.status);
}

export function mergeFilters(existing = [], incoming = [], wildcardFields = ['*'], opts = {}) {
  const hasWildcard = (arr) => Array.isArray(arr) && arr.some(v => wildcardFields.includes(v));
  if (opts.narrowWildcard && hasWildcard(existing)) return boundedList(incoming);
  if (opts.narrowWildcard && hasWildcard(incoming)) return boundedList(existing);
  if (hasWildcard(existing) || hasWildcard(incoming)) return ['*'];
  return [...new Set([...(incoming || []), ...(existing || [])])];
}

function listMatch(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.includes('*') || list.includes(value);
}

function stableHex(input) {
  // Browser-safe deterministic 128-bit-ish non-crypto hash for local v0 event ids.
  // The Cloudflare DO backend can use WebCrypto; this standalone docs demo needs no node polyfill.
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  let c = 0x85ebca6b;
  let d = 0xc2b2ae35;
  for (let i = 0; i < input.length; i++) {
    const x = input.charCodeAt(i);
    a = Math.imul(a ^ x, 0x01000193) >>> 0;
    b = Math.imul(b + x, 0x85ebca6b) >>> 0;
    c = Math.imul(c ^ (x + i), 0xc2b2ae35) >>> 0;
    d = Math.imul(d + (x ^ i), 0x27d4eb2d) >>> 0;
  }
  return [a, b, c, d].map(n => n.toString(16).padStart(8, '0')).join('');
}
