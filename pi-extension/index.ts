import * as fs from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { homedir } from 'node:os';
import crypto from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const ROOT = join(homedir(), '.terrarium', 'router');
const SUBS = join(ROOT, 'subscribers');
const MAIL = join(ROOT, 'mailboxes');
const TERMINAL = new Set(['Completed', 'Failed', 'TimedOut', 'Cancelled']);
import { claimedEvents, isTerrariumSpawnTool } from './callback-shape.js';

let watcher: fs.FSWatcher | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
let busy = false;
let pending: string[] = [];
let ctxRef: ExtensionContext | undefined;
let subscriberId = '';
let runIds: string[] = [];
let activeRunIds = new Set<string>();
let pendingLaunches = 0;
let clearAfterTurn = false;
let spinner: ReturnType<typeof setInterval> | undefined;
let spinnerIndex = 0;
const frames = ['▖','▘','▝','▗'];
const TERMINAL_RUN_STATUSES = new Set(['done', 'completed', 'failed', 'timed_out', 'timeout', 'cancelled', 'orphaned', 'dead']);
const RUNS_DIR = join(homedir(), '.terrarium', 'runs');

const pidAlive = (pid: unknown) => {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const readRunRecord = (runId: string): any | null => {
  try { return JSON.parse(readFileSync(join(RUNS_DIR, `${runId}.json`), 'utf8')); } catch { return null; }
};
const isRunStillActive = (runId: string) => {
  const record = readRunRecord(runId);
  if (!record) return false;
  const status = String(record.status || '').toLowerCase();
  if (TERMINAL_RUN_STATUSES.has(status)) return false;
  if (record.finishedAt || record.exitCode !== undefined || record.signal !== undefined) return false;
  if (status === 'running' || status === 'active' || status === 'needs_attention') return pidAlive(record.pid);
  return false;
};
const pruneInactiveActiveRuns = () => {
  for (const id of [...activeRunIds]) if (!isRunStillActive(id)) activeRunIds.delete(id);
};

const readHomeConfig = (): Record<string, any> => {
  try { return JSON.parse(readFileSync(join(homedir(), '.terrarium', 'config.json'), 'utf8')) || {}; } catch { return {}; }
};
const PULSE_URL = (process.env.PULSE_URL || process.env.TERRARIUM_URL || readHomeConfig().cloudUrl || '').replace(/\/$/, '');
const accessUserToken = (): string => {
  if (readHomeConfig().accessLogin !== true || !PULSE_URL) return '';
  try {
    const { execFileSync } = require('node:child_process');
    return String(execFileSync('cloudflared', ['access', 'token', `--app=${PULSE_URL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })).trim();
  } catch { return ''; }
};
const accessHeaders = (): Record<string, string> => {
  const userToken = accessUserToken();
  if (userToken.includes('.')) return { 'cf-access-token': userToken };
  const config = readHomeConfig();
  const id = process.env.TERRARIUM_ACCESS_CLIENT_ID || (config.accessClientIdFile ? readFileSync(config.accessClientIdFile, 'utf8').trim() : '');
  const secret = process.env.TERRARIUM_ACCESS_CLIENT_SECRET || (config.accessClientSecretFile ? readFileSync(config.accessClientSecretFile, 'utf8').trim() : '');
  return id && secret ? { 'cf-access-client-id': id, 'cf-access-client-secret': secret } : {};
};
const readSecretFile = (path: string): string => {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
};
const resolvePulseToken = (): string => {
  if (process.env.PULSE_TOKEN) return process.env.PULSE_TOKEN;
  if (process.env.TERRARIUM_PULSE_TOKEN) return process.env.TERRARIUM_PULSE_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.terrarium', 'config.json'), 'utf8'));
    if (cfg.pulseTokenFile) {
      const t = readSecretFile(cfg.pulseTokenFile);
      if (t) return t;
    }
  } catch { }
  return readSecretFile(join(homedir(), '.terrarium', 'secrets', 'prod-pulse-token.secret'));
};
const PULSE_TOKEN = resolvePulseToken();
const cloudEnabled = () => PULSE_URL.length > 0 && (PULSE_TOKEN.length > 0 || readHomeConfig().accessLogin === true);
let cloudSubscriberId = '';
let cloudSubscribed = false;
const seenRunIds = new Set<string>();

async function pulseFetch(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${PULSE_URL}${path}`, {
    method: 'POST',
    headers: (() => { const access = accessHeaders(); const signedIn = 'cf-access-token' in access; return { ...access, 'content-type': 'application/json', ...(signedIn || !PULSE_TOKEN ? {} : { authorization: `Bearer ${PULSE_TOKEN}` }) }; })(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pulse ${path} -> ${res.status}`);
  return res.json().catch(() => ({}));
}

const dirs = () => ({
  root: join(MAIL, subscriberId),
  pending: join(MAIL, subscriberId, 'pending'),
  inflight: join(MAIL, subscriberId, 'inflight'),
  acked: join(MAIL, subscriberId, 'acked'),
});
const ensureDirs = () => {
  const d = dirs();
  mkdirSync(SUBS, { recursive: true });
  mkdirSync(d.pending, { recursive: true });
  mkdirSync(d.inflight, { recursive: true });
  mkdirSync(d.acked, { recursive: true });
};
const writeSubscription = () => {
  ensureDirs();
  const nowIso = new Date().toISOString();
  let createdAt = nowIso;
  try {
    const prev = JSON.parse(readFileSync(join(SUBS, `${subscriberId}.json`), 'utf8'));
    if (prev && typeof prev.createdAt === 'string') createdAt = prev.createdAt;
  } catch { }
  writeFileSync(join(SUBS, `${subscriberId}.json`), JSON.stringify({
    version: 1,
    subscriberId,
    channels: ['*'],
    workflowIds: ['*'],
    eventTypes: ['Completed', 'Failed', 'TimedOut', 'Cancelled'],
    runIds,
    ownerRunId: null,
    createdAt,
    updatedAt: nowIso,
  }, null, 2));
};
const startSpinner = () => {
  if (spinner) clearInterval(spinner);
  spinnerIndex = 0;
  spinner = setInterval(() => {
    ctxRef?.ui.setStatus('terrarium-progress', ctxRef.ui.theme.fg('success', `terrarium ${frames[spinnerIndex++ % frames.length]}`));
  }, 180);
};
const stopSpinner = () => { if (spinner) clearInterval(spinner); spinner = undefined; };
const stillActive = () => {
  pruneInactiveActiveRuns();
  return pendingLaunches > 0 || activeRunIds.size > 0;
};

export default function terrariumAutocontinue(pi: ExtensionAPI) {
  const wakeFromEvent = (event: any) => {
    const rid = String(event?.runId ?? '');
    if (rid && seenRunIds.has(rid)) return false;
    if (rid) seenRunIds.add(rid);
    const wasActive = rid ? activeRunIds.delete(rid) : false;
    if (wasActive && stillActive()) startSpinner();
    else if (wasActive) {
      stopSpinner();
      clearAfterTurn = true;
      ctxRef?.ui.setStatus('terrarium-progress', ctxRef.ui.theme.fg('success', 'terrarium done'));
    }
    pending.push(JSON.stringify(event));
    return true;
  };
  const cloudSubscribe = async () => {
    if (!cloudEnabled() || !cloudSubscriberId) return;
    if (runIds.length === 0) { cloudSubscribed = false; return; }
    try {
      await pulseFetch('/pulse', {
        action: 'subscribe',
        subscriberId: cloudSubscriberId,
        channels: ['*'],
        workflowIds: ['*'],
        eventTypes: ['Completed', 'Failed', 'TimedOut', 'Cancelled'],
        runIds,
      });
      cloudSubscribed = true;
    } catch (error) { try { fs.appendFileSync(join(homedir(), '.terrarium', 'autocontinue-cloud.log'), `${new Date().toISOString()} subscribe ${cloudSubscriberId} ${String((error as any)?.message ?? error)}\n`); } catch {} }
  };
  const cloudPoll = async () => {
    if (!cloudEnabled() || !cloudSubscriberId) return;
    try {
      if (!cloudSubscribed) await cloudSubscribe();
      if (!cloudSubscribed) return;
      const claimed = await pulseFetch('/claim', { subscriberId: cloudSubscriberId, ownerRunId: null, limit: 25 });
      const events = claimedEvents(claimed);
      for (const event of (Array.isArray(events) ? events : [])) {
        if (!TERMINAL.has(event?.type)) { continue; }
        const woke = wakeFromEvent(event);
        try { await pulseFetch('/ack', { subscriberId: cloudSubscriberId, ownerRunId: null, eventId: event?.eventId ?? event?.id }); } catch {}
        if (woke) drainRef?.();
      }
    } catch (error) { try { fs.appendFileSync(join(homedir(), '.terrarium', 'autocontinue-cloud.log'), `${new Date().toISOString()} poll ${cloudSubscriberId} ${String((error as any)?.message ?? error)}\n`); } catch {} }
  };
  let drainRef: (() => void) | undefined;
  const drain = () => {
    if (busy || pending.length === 0) return;
    const event = pending.shift()!;
    pi.sendMessage({ customType: 'terrarium-completed', content: `Terrarium completion event:\n\n${event}\n\nRead the result, integrate it if appropriate, and continue orchestration.`, display: true }, { triggerTurn: true, deliverAs: 'followUp' });
  };
  drainRef = drain;
  const consumeFile = (file: string) => {
    const d = dirs();
    const source = join(d.pending, file);
    const target = join(d.inflight, file);
    try { renameSync(source, target); } catch { return; }
    let event: any;
    try { event = JSON.parse(readFileSync(target, 'utf8')); }
    catch { rmSync(target, { force: true }); return; }
    if (!TERMINAL.has(event.type) || !runIds.includes(String(event.runId))) { rmSync(target, { force: true }); return; }
    if (!Object.hasOwn(event, 'claimedAt')) {
      event.claimedAt = new Date().toISOString();
      try { writeFileSync(target, `${JSON.stringify(event)}\n`); } catch { rmSync(target, { force: true }); return; }
    }
    if (seenRunIds.has(String(event.runId))) {
      const dup = activeRunIds.delete(String(event.runId));
      if (dup && !stillActive()) { stopSpinner(); ctxRef?.ui.setStatus('terrarium-progress', undefined); }
      try { renameSync(target, join(d.acked, file)); } catch { rmSync(target, { force: true }); }
      return;
    }
    seenRunIds.add(String(event.runId));
    const wasActive = activeRunIds.delete(String(event.runId));
    if (wasActive && stillActive()) startSpinner();
    else if (wasActive) {
      stopSpinner();
      clearAfterTurn = true;
      ctxRef?.ui.setStatus('terrarium-progress', ctxRef.ui.theme.fg('success', 'terrarium done'));
    }
    pending.push(JSON.stringify(event));
    try { renameSync(target, join(d.acked, file)); } catch { rmSync(target, { force: true }); }
    drain();
  };
  const scan = () => {
    if (!subscriberId) return;
    ensureDirs();
    try { for (const file of readdirSync(dirs().pending).filter((n) => n.endsWith('.json')).sort()) consumeFile(file); } catch {}
  };
  const requeueInflight = () => {
    ensureDirs();
    const d = dirs();
    try { for (const file of readdirSync(d.inflight).filter((n) => n.endsWith('.json'))) { try { renameSync(join(d.inflight, file), join(d.pending, file)); } catch {} } } catch {}
  };
  pi.on('session_start', async (_event, ctx) => {
    ctxRef = ctx;
    const sessionFile = ctx.sessionManager.getSessionFile() || ctx.cwd || 'default';
    const sessionHash = crypto.createHash('sha256').update(sessionFile).digest('hex').slice(0, 20);
    subscriberId = `pi-${sessionHash}`;
    cloudSubscriberId = `pi-cloud-${sessionHash}`;
    cloudSubscribed = false;
    try {
      const existing = JSON.parse(readFileSync(join(SUBS, `${subscriberId}.json`), 'utf8'));
      runIds = Array.isArray(existing.runIds) ? existing.runIds.filter((id: unknown) => typeof id === 'string' && id.startsWith('ter_')) : [];
    } catch { runIds = []; }
    writeSubscription();
    requeueInflight();
    watcher?.close();
    watcher = fs.watch(dirs().pending, { persistent: true }, () => setTimeout(scan, 50));
    if (interval) clearInterval(interval);
    interval = setInterval(() => {
      scan();
      void cloudPoll();
      if (!stillActive()) { stopSpinner(); ctxRef?.ui.setStatus('terrarium-progress', undefined); }
    }, 1500);
    interval.unref?.();
    ctx.ui.setStatus('terrarium-progress', undefined);
    scan();
    if (cloudEnabled()) { void cloudSubscribe().then(() => cloudPoll()); }
    if (ctx.hasUI) ctx.ui.notify(cloudEnabled() ? 'Watching durable Terrarium callbacks (local + cloud pulse)' : 'Watching durable Terrarium callbacks', 'info');
  });
  pi.on('tool_call', async (event) => {
    if (!isTerrariumSpawnTool(event.toolName)) return;
    pendingLaunches++;
    startSpinner();
    writeSubscription();
  });
  pi.on('tool_result', async (event) => {
    if (!isTerrariumSpawnTool(event.toolName)) return;
    const found = new Set<string>();
    const collect = (value: any) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.runId === 'string' && value.runId.startsWith('ter_')) found.add(value.runId);
      for (const item of Object.values(value)) Array.isArray(item) ? item.forEach(collect) : collect(item);
    };
    let payload: any = null;
    const text = event.content?.find?.((item: any) => item.type === 'text')?.text;
    if (typeof text === 'string') {
      try { payload = JSON.parse(text); } catch { payload = null; }
      const ids = text.match(/ter_[0-9]+_[a-z0-9]+/gi);
      if (ids) for (const id of ids) found.add(id);
    }
    collect(payload);
    if (event.isError && found.size === 0) {
      if (pendingLaunches > 0) pendingLaunches--;
      if (!stillActive()) { stopSpinner(); ctxRef?.ui.setStatus('terrarium-progress', undefined); }
      return;
    }
    if (pendingLaunches > 0) pendingLaunches--;
    for (const id of found) {
      if (!runIds.includes(id)) runIds.push(id);
      if (isRunStillActive(id)) activeRunIds.add(id);
      else activeRunIds.delete(id);
    }
    if (found.size) {
      writeSubscription();
      scan();
      if (cloudEnabled()) { void cloudSubscribe().then(() => cloudPoll()); }
    }
    if (stillActive()) startSpinner();
  });
  pi.on('agent_start', async () => { busy = true; });
  pi.on('agent_end', async (_event, ctx) => { busy = false; ctxRef = ctx; if (clearAfterTurn && !stillActive()) { clearAfterTurn = false; ctx.ui.setStatus('terrarium-progress', undefined); } drain(); });
  pi.on('session_shutdown', async () => {
    stopSpinner();
    watcher?.close(); watcher = undefined;
    if (interval) clearInterval(interval); interval = undefined;
    pending = []; ctxRef = undefined; clearAfterTurn = false; pendingLaunches = 0; activeRunIds = new Set<string>();
    cloudSubscribed = false; cloudSubscriberId = '';
    seenRunIds.clear();
    subscriberId = ''; runIds = [];
  });
}
