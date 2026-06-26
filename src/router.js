import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
const HOME = process.env.TERRARIUM_HOME ? resolve(process.env.TERRARIUM_HOME) : join(homedir(), '.terrarium');

export const ROUTER_DIR = join(HOME, 'router');
export const JOURNAL_DIR = join(ROUTER_DIR, 'journal');
export const SUBSCRIBERS_DIR = join(ROUTER_DIR, 'subscribers');
export const MAILBOXES_DIR = join(ROUTER_DIR, 'mailboxes');

function assertId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}
function boundedList(value, fallback = ['*']) {
  const list = value ?? fallback;
  if (!Array.isArray(list) || list.length < 1 || list.length > 100 || list.some((item) => typeof item !== 'string' || item.length > 200)) throw new Error('invalid subscription filter');
  return [...new Set(list)];
}
function mailboxDirs(subscriberId) {
  const root = join(MAILBOXES_DIR, assertId(subscriberId, 'subscriber id'));
  return { root, pending: join(root, 'pending'), inflight: join(root, 'inflight'), acked: join(root, 'acked') };
}
function eventId(event) {
  if (event.eventId) return assertId(event.eventId, 'event id');
  return `evt_${createHash('sha256').update(JSON.stringify([event.runId, event.type, event.at, event.status, event.exitCode])).digest('hex').slice(0, 32)}`;
}
function sanitizeCallbackEvent(event) {
  const allowed = ['type', 'eventId', 'runId', 'parentRunId', 'taskFingerprint', 'workflowId', 'sessionId', 'channel', 'at', 'status', 'ok', 'exitCode', 'signal', 'dryRun'];
  return Object.fromEntries(allowed.filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
}
function isValidCallbackEvent(event, expectedEventId) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (event.eventId !== expectedEventId || !TERMINAL_EVENT_TYPES.includes(event.type) || typeof event.runId !== 'string') return false;
  return Object.keys(event).every((key) => CALLBACK_EVENT_KEYS.has(key));
}

async function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, path);
}

const TERMINAL_EVENT_TYPES = ['Completed', 'Failed', 'TimedOut', 'Cancelled'];
const CALLBACK_EVENT_KEYS = new Set(['type', 'eventId', 'runId', 'parentRunId', 'taskFingerprint', 'workflowId', 'sessionId', 'channel', 'at', 'status', 'ok', 'exitCode', 'signal', 'dryRun', 'claimedAt']);

export async function registerSubscriber(subscription) {
  const subscriberId = assertId(subscription.subscriberId, 'subscriber id');
  if (subscription.ownerRunId != null && !/^ter_[A-Za-z0-9_]+$/.test(subscription.ownerRunId)) throw new Error('invalid subscriber owner run id');
  let existing = null;
  try { existing = await getSubscriber(subscriberId); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const mergeFilters = (requested, prior, fallback, { narrowWildcard = false } = {}) => {
    const next = boundedList(requested, fallback);
    if (!prior) return next;
    const previous = boundedList(prior, fallback);
    if (next.includes('*')) return ['*'];
    if (previous.includes('*')) return narrowWildcard ? next : ['*'];
    return [...new Set([...previous, ...next])];
  };
  const ownerRunId = subscription.ownerRunId ?? existing?.ownerRunId ?? null;
  if (existing && existing.ownerRunId !== (subscription.ownerRunId ?? null)) {
    throw new Error('subscriber is owned by another run or controller');
  }
  const normalized = {
    version: 1,
    subscriberId,
    channels: mergeFilters(subscription.channels, existing?.channels, ['*']),
    workflowIds: mergeFilters(subscription.workflowIds, existing?.workflowIds, ['*']),
    eventTypes: mergeFilters(subscription.eventTypes, existing?.eventTypes, TERMINAL_EVENT_TYPES),
    runIds: mergeFilters(subscription.runIds, existing?.runIds, ['*'], { narrowWildcard: subscription.narrowWildcardRunIds === true }),
    ownerRunId,
    createdAt: existing?.createdAt ?? subscription.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(SUBSCRIBERS_DIR, { recursive: true });
  const dirs = mailboxDirs(subscriberId);
  await Promise.all([mkdir(dirs.pending, { recursive: true }), mkdir(dirs.inflight, { recursive: true }), mkdir(dirs.acked, { recursive: true })]);
  await atomicJson(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), normalized);
  const requestedRuns = boundedList(subscription.runIds);
  const requestedSubscription = {
    ...normalized,
    channels: boundedList(subscription.channels),
    workflowIds: boundedList(subscription.workflowIds),
    eventTypes: boundedList(subscription.eventTypes, TERMINAL_EVENT_TYPES),
    runIds: requestedRuns,
  };
  const replayed = await replayJournalToSubscriber(requestedSubscription, { concreteRuns: !requestedRuns.includes('*') });
  return { ...normalized, replayed };
}

export async function getSubscriber(subscriberId) {
  assertId(subscriberId, 'subscriber id');
  let subscription;
  try { subscription = JSON.parse(await readFile(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw new Error('invalid callback subscriber record');
  }
  if (!subscription || subscription.subscriberId !== subscriberId ||
      !Object.hasOwn(subscription, 'ownerRunId') ||
      (subscription.ownerRunId !== null && !/^ter_[A-Za-z0-9_]+$/.test(subscription.ownerRunId))) {
    throw new Error('invalid callback subscriber record');
  }
  return subscription;
}

function assertSubscriberOwner(subscription, ownerRunId) {
  const storedOwner = subscription.ownerRunId ?? null;
  if (storedOwner !== (ownerRunId ?? null)) throw new Error('callback subscriber access denied');
}

export async function unregisterSubscriber(subscriberId, { ownerRunId } = {}) {
  assertId(subscriberId, 'subscriber id');
  assertSubscriberOwner(await getSubscriber(subscriberId), ownerRunId);
  await Promise.all([
    rm(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true }),
    rm(mailboxDirs(subscriberId).root, { recursive: true, force: true }),
  ]);
}

export async function listSubscribers() {
  if (!existsSync(SUBSCRIBERS_DIR)) return [];
  const files = (await readdir(SUBSCRIBERS_DIR)).filter((f) => f.endsWith('.json'));
  const values = [];
  for (const file of files) {
    try {
      const subscriberId = file.slice(0, -5);
      values.push(await getSubscriber(subscriberId));
    } catch {}
  }
  return values;
}

export function matches(subscription, event) {
  const channels = subscription.channels ?? ['*'];
  const workflows = subscription.workflowIds ?? ['*'];
  const types = subscription.eventTypes ?? ['*'];
  const runs = subscription.runIds ?? ['*'];
  // Pi host delivery is session-bound. Old/global Pi extensions once wrote
  // wildcard run subscriptions, which caused callbacks to wake sibling Pi
  // sessions sharing a cwd/channel. Keep wildcard support for explicit pull
  // consumers, but never let pi-* / pi_* subscribers match every run.
  if (/^pi[-_]/.test(subscription.subscriberId || '') && runs.includes('*')) return false;
  return (channels.includes('*') || channels.includes(event.channel)) &&
    (workflows.includes('*') || workflows.includes(event.workflowId)) &&
    (types.includes('*') || types.includes(event.type)) &&
    (runs.includes('*') || runs.includes(event.runId));
}

async function enqueueEvent(subscriberId, event) {
  const dirs = mailboxDirs(subscriberId);
  const file = `${event.eventId}.json`;
  if ([dirs.pending, dirs.inflight, dirs.acked].some((dir) => existsSync(join(dir, file)))) return false;
  await mkdir(dirs.pending, { recursive: true });
  try { await writeFile(join(dirs.pending, file), `${JSON.stringify(event)}\n`, { flag: 'wx' }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

async function replayJournalToSubscriber(subscription, { concreteRuns = false } = {}) {
  // Wildcard subscribers start at registration time. Only explicit run IDs may
  // replay history, which closes finish-before-subscribe without flooding a new
  // consumer with every historical terminal event.
  if (!concreteRuns || !existsSync(JOURNAL_DIR)) return 0;
  let replayed = 0;
  for (const file of (await readdir(JOURNAL_DIR)).filter((name) => name.endsWith('.json')).sort()) {
    let event; try { event = sanitizeCallbackEvent(JSON.parse(await readFile(join(JOURNAL_DIR, file), 'utf8'))); } catch { continue; }
    if (!TERMINAL_EVENT_TYPES.includes(event.type) || !matches(subscription, event)) continue;
    if (await enqueueEvent(subscription.subscriberId, event)) replayed++;
  }
  return replayed;
}

export async function routeEvent(event) {
  const id = eventId(event);
  const routed = sanitizeCallbackEvent({ ...event, eventId: id });
  await mkdir(JOURNAL_DIR, { recursive: true });
  try { await writeFile(join(JOURNAL_DIR, `${id}.json`), `${JSON.stringify(routed)}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return { eventId: id, duplicate: true, delivered: 0 }; throw error; }
  let delivered = 0;
  for (const sub of await listSubscribers()) {
    if (!matches(sub, routed)) continue;
    if (await enqueueEvent(sub.subscriberId, routed)) delivered++;
  }
  return { eventId: id, duplicate: false, delivered };
}

export async function claimMailboxEvents({ subscriberId, limit = 20, ownerRunId } = {}) {
  assertSubscriberOwner(await getSubscriber(subscriberId), ownerRunId);
  const dirs = mailboxDirs(subscriberId);
  await Promise.all([mkdir(dirs.pending, { recursive: true }), mkdir(dirs.inflight, { recursive: true })]);
  const files = (await readdir(dirs.pending)).filter((file) => file.endsWith('.json')).sort().slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100));
  const events = [];
  for (const file of files) {
    try {
      const target = join(dirs.inflight, file);
      await rename(join(dirs.pending, file), target);
      let parsed;
      try { parsed = JSON.parse(await readFile(target, 'utf8')); }
      catch {
        await rename(target, join(dirs.pending, file)).catch(() => {});
        continue;
      }
      if (!isValidCallbackEvent(parsed, file.slice(0, -5))) {
        await rename(target, join(dirs.pending, file)).catch(() => {});
        continue;
      }
      const event = { ...sanitizeCallbackEvent(parsed), claimedAt: new Date().toISOString() };
      await atomicJson(target, event);
      events.push(event);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { subscriberId, events };
}

export async function acknowledgeMailboxEvent({ subscriberId, eventId: id, ownerRunId } = {}) {
  assertSubscriberOwner(await getSubscriber(subscriberId), ownerRunId);
  const dirs = mailboxDirs(subscriberId);
  assertId(id, 'event id');
  await mkdir(dirs.acked, { recursive: true });
  const source = join(dirs.inflight, `${id}.json`);
  const target = join(dirs.acked, `${id}.json`);
  try { await rename(source, target); return { subscriberId, eventId: id, acknowledged: true }; }
  catch (error) {
    if (error.code === 'ENOENT' && existsSync(target)) return { subscriberId, eventId: id, acknowledged: true, duplicate: true };
    throw new Error(`event is not inflight: ${id}`);
  }
}

export async function getMailboxStatus(subscriberId, { ownerRunId } = {}) {
  assertSubscriberOwner(await getSubscriber(subscriberId), ownerRunId);
  const dirs = mailboxDirs(subscriberId);
  const countValidEvents = async (dir) => {
    let count = 0;
    let files = []; try { files = (await readdir(dir)).filter((file) => file.endsWith('.json')); } catch { return 0; }
    for (const file of files) {
      let event; try { event = JSON.parse(await readFile(join(dir, file), 'utf8')); } catch { continue; }
      if (isValidCallbackEvent(event, file.slice(0, -5))) count++;
    }
    return count;
  };
  return { subscriberId, pending: await countValidEvents(dirs.pending), inflight: await countValidEvents(dirs.inflight), acknowledged: await countValidEvents(dirs.acked) };
}

export async function requeueInflightEvents({ subscriberId, olderThanMs = 300000, ownerRunId } = {}) {
  assertSubscriberOwner(await getSubscriber(subscriberId), ownerRunId);
  const dirs = mailboxDirs(subscriberId);
  await Promise.all([mkdir(dirs.pending, { recursive: true }), mkdir(dirs.inflight, { recursive: true })]);
  const now = Date.now();
  let requeued = 0;
  for (const file of (await readdir(dirs.inflight)).filter((name) => name.endsWith('.json'))) {
    let event; try { event = JSON.parse(await readFile(join(dirs.inflight, file), 'utf8')); } catch { continue; }
    const age = now - Date.parse(event.claimedAt || event.at || new Date(now).toISOString());
    if (age < Math.max(0, Number(olderThanMs) || 0)) continue;
    try { await rename(join(dirs.inflight, file), join(dirs.pending, file)); requeued++; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { subscriberId, requeued };
}

function eventAge(now, event) {
  const timestamp = Date.parse(event.claimedAt || event.at || '');
  return Number.isFinite(timestamp) ? now - timestamp : Infinity;
}

export async function pruneRouter({ acknowledgedOlderThanMs = 7 * 86400000, journalOlderThanMs = 7 * 86400000, callbackOlderThanMs = 7 * 86400000, subscriberOlderThanMs = 7 * 86400000, subscriberIds, eventIds, ownerRunId } = {}) {
  const now = Date.now();
  let acknowledgedRemoved = 0, pendingRemoved = 0, inflightRemoved = 0, journalRemoved = 0, subscribersRemoved = 0;
  const callbackCutoff = Math.max(0, Number(callbackOlderThanMs) || 0);
  const subscriberCutoff = Math.max(0, Number(subscriberOlderThanMs) || 0);
  try {
    for (const subscriber of await readdir(MAILBOXES_DIR)) {
      if (Array.isArray(subscriberIds) && !subscriberIds.includes(subscriber)) continue;
      let subscription; try { subscription = await getSubscriber(subscriber); } catch { continue; }
      // A top-level prune may maintain only controller-owned mailboxes. Child
      // ownership must never make pruning abort early or reach another child.
      if (subscription.ownerRunId !== (ownerRunId ?? null)) continue;
      const dirs = mailboxDirs(subscriber);
      for (const [kind, dir, cutoff] of [
        ['acked', dirs.acked, acknowledgedOlderThanMs],
        ['pending', dirs.pending, callbackCutoff],
        ['inflight', dirs.inflight, callbackCutoff],
      ]) {
        let files = []; try { files = (await readdir(dir)).filter((file) => file.endsWith('.json')); } catch {}
        for (const file of files) {
          if (Array.isArray(eventIds) && !eventIds.includes(file.slice(0, -5))) continue;
          let event; try { event = JSON.parse(await readFile(join(dir, file), 'utf8')); } catch { continue; }
          if (!isValidCallbackEvent(event, file.slice(0, -5))) continue;
          if (eventAge(now, event) < Math.max(0, Number(cutoff) || 0)) continue;
          await rm(join(dir, file), { force: true });
          if (kind === 'acked') acknowledgedRemoved++;
          else if (kind === 'pending') pendingRemoved++;
          else inflightRemoved++;
        }
      }
    }
  } catch {}
  try {
    for (const file of (await readdir(JOURNAL_DIR)).filter((name) => name.endsWith('.json'))) {
      if (Array.isArray(eventIds) && !eventIds.includes(file.slice(0, -5))) continue;
      let event; try { event = JSON.parse(await readFile(join(JOURNAL_DIR, file), 'utf8')); } catch { continue; }
      const age = now - Date.parse(event.at || '');
      if (Number.isFinite(age) && age >= Math.max(0, Number(journalOlderThanMs) || 0)) { await rm(join(JOURNAL_DIR, file), { force: true }); journalRemoved++; }
    }
  } catch {}
  try {
    for (const sub of await listSubscribers()) {
      if (Array.isArray(subscriberIds) && !subscriberIds.includes(sub.subscriberId)) continue;
      if (sub.ownerRunId !== (ownerRunId ?? null)) continue;
      const age = now - Date.parse(sub.createdAt || '');
      if (!Number.isFinite(age) || age < subscriberCutoff) continue;
      const status = await getMailboxStatus(sub.subscriberId, { ownerRunId: sub.ownerRunId });
      if (status.pending || status.inflight) continue;
      await unregisterSubscriber(sub.subscriberId, { ownerRunId: sub.ownerRunId });
      subscribersRemoved++;
    }
  } catch {}
  return { acknowledgedRemoved, pendingRemoved, inflightRemoved, journalRemoved, subscribersRemoved };
}
