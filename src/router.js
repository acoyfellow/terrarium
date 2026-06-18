import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const HOME = join(homedir(), '.terrarium');

export const ROUTER_DIR = join(HOME, 'router');
export const JOURNAL_DIR = join(ROUTER_DIR, 'journal');
export const SUBSCRIBERS_DIR = join(ROUTER_DIR, 'subscribers');
export const MAILBOXES_DIR = join(ROUTER_DIR, 'mailboxes');

export async function registerSubscriber(subscription) {
  await mkdir(SUBSCRIBERS_DIR, { recursive: true });
  await mkdir(join(MAILBOXES_DIR, subscription.subscriberId), { recursive: true });
  await writeFile(join(SUBSCRIBERS_DIR, `${subscription.subscriberId}.json`), `${JSON.stringify(subscription, null, 2)}\n`);
}

export async function unregisterSubscriber(subscriberId) {
  await rm(join(SUBSCRIBERS_DIR, `${subscriberId}.json`), { force: true });
}

export async function listSubscribers() {
  if (!existsSync(SUBSCRIBERS_DIR)) return [];
  const files = (await readdir(SUBSCRIBERS_DIR)).filter((f) => f.endsWith('.json'));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(SUBSCRIBERS_DIR, f), 'utf8'))));
}

export function matches(subscription, event) {
  const channels = subscription.channels ?? ['*'];
  const workflows = subscription.workflowIds ?? ['*'];
  const types = subscription.eventTypes ?? ['*'];
  return (channels.includes('*') || channels.includes(event.channel)) &&
    (workflows.includes('*') || workflows.includes(event.workflowId)) &&
    (types.includes('*') || types.includes(event.type));
}

export async function routeEvent(event) {
  await mkdir(JOURNAL_DIR, { recursive: true });
  await writeFile(join(JOURNAL_DIR, `${event.at.replace(/[:.]/g, '-')}-${event.runId}-${event.type}.json`), `${JSON.stringify(event)}\n`);
  for (const sub of await listSubscribers()) {
    if (!matches(sub, event)) continue;
    const dir = join(MAILBOXES_DIR, sub.subscriberId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${event.at.replace(/[:.]/g, '-')}-${event.runId}-${event.type}.json`), `${JSON.stringify(event)}\n`);
  }
}
