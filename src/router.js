import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const HOME = join(homedir(), '.terrarium');

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
async function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temp, path);
}

export async function registerSubscriber(subscription) {
  const subscriberId = assertId(subscription.subscriberId, 'subscriber id');
  if (subscription.ownerRunId != null && !/^ter_[A-Za-z0-9_]+$/.test(subscription.ownerRunId)) throw new Error('invalid subscriber owner run id');
  const normalized = {
    version: 1,
    subscriberId,
    channels: boundedList(subscription.channels),
    workflowIds: boundedList(subscription.workflowIds),
    eventTypes: boundedList(subscription.eventTypes),
    runIds: boundedList(subscription.runIds),
    ownerRunId: subscription.ownerRunId ?? null,
    createdAt: subscription.createdAt ?? new Date().toISOString(),
  };
  await mkdir(SUBSCRIBERS_DIR, { recursive: true });
  const dirs = mailboxDirs(subscriberId);
  await Promise.all([mkdir(dirs.pending, { recursive: true }), mkdir(dirs.inflight, { recursive: true }), mkdir(dirs.acked, { recursive: true })]);
  await atomicJson(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), normalized);
  return normalized;
}

export async function getSubscriber(subscriberId) {
  assertId(subscriberId, 'subscriber id');
  return JSON.parse(await readFile(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), 'utf8'));
}

export async function unregisterSubscriber(subscriberId) {
  assertId(subscriberId, 'subscriber id');
  await rm(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
}

export async function listSubscribers() {
  if (!existsSync(SUBSCRIBERS_DIR)) return [];
  const files = (await readdir(SUBSCRIBERS_DIR)).filter((f) => f.endsWith('.json'));
  const values = [];
  for (const file of files) { try { values.push(JSON.parse(await readFile(join(SUBSCRIBERS_DIR, file), 'utf8'))); } catch {} }
  return values;
}

export function matches(subscription, event) {
  const channels = subscription.channels ?? ['*'];
  const workflows = subscription.workflowIds ?? ['*'];
  const types = subscription.eventTypes ?? ['*'];
  const runs = subscription.runIds ?? ['*'];
  return (channels.includes('*') || channels.includes(event.channel)) &&
    (workflows.includes('*') || workflows.includes(event.workflowId)) &&
    (types.includes('*') || types.includes(event.type)) &&
    (runs.includes('*') || runs.includes(event.runId));
}

export async function routeEvent(event) {
  const id = eventId(event);
  const routed = { ...event, eventId: id };
  await mkdir(JOURNAL_DIR, { recursive: true });
  try { await writeFile(join(JOURNAL_DIR, `${id}.json`), `${JSON.stringify(routed)}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return { eventId: id, duplicate: true, delivered: 0 }; throw error; }
  let delivered = 0;
  for (const sub of await listSubscribers()) {
    if (!matches(sub, routed)) continue;
    const dirs = mailboxDirs(sub.subscriberId);
    await mkdir(dirs.pending, { recursive: true });
    try { await writeFile(join(dirs.pending, `${id}.json`), `${JSON.stringify(routed)}\n`, { flag: 'wx' }); delivered++; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return { eventId: id, duplicate: false, delivered };
}

export async function claimMailboxEvents({ subscriberId, limit = 20 } = {}) {
  const dirs = mailboxDirs(subscriberId);
  await Promise.all([mkdir(dirs.pending, { recursive: true }), mkdir(dirs.inflight, { recursive: true })]);
  const files = (await readdir(dirs.pending)).filter((file) => file.endsWith('.json')).sort().slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100));
  const events = [];
  for (const file of files) {
    try {
      await rename(join(dirs.pending, file), join(dirs.inflight, file));
      events.push(JSON.parse(await readFile(join(dirs.inflight, file), 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { subscriberId, events };
}

export async function acknowledgeMailboxEvent({ subscriberId, eventId: id } = {}) {
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

export async function getMailboxStatus(subscriberId) {
  const dirs = mailboxDirs(subscriberId);
  const count = async (dir) => { try { return (await readdir(dir)).filter((file) => file.endsWith('.json')).length; } catch { return 0; } };
  return { subscriberId, pending: await count(dirs.pending), inflight: await count(dirs.inflight), acknowledged: await count(dirs.acked) };
}
