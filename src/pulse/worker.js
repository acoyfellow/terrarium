// Pulse Worker — plain HTTP front for the PulseRouter Durable Object.
//
// Routes (all require a capability bearer token):
//   POST /pulse   -> emit/route a terminal event (also: subscribe/unsubscribe/requeue)
//   POST /claim   -> claim pending mailbox events
//   POST /ack     -> acknowledge an inflight event
//   GET  /status  -> mailbox counts for a subscriber
//
// Authz: Bearer token compared against env.PULSE_TOKEN. Fail-closed: any missing
// token (request or env) is 401. No secrets in code — PULSE_TOKEN is a wrangler
// secret. Access (Cloudflare Zero Trust) is layered in front in prod; this token
// is the capability gate the e2e exercises.
//
// One DO instance per "router" name keeps journal+subscribers+mailboxes colocated
// and serialized. Default name "global"; callers may shard via ?router= / body.router.

import { PulseRouter } from './do.js';

export { PulseRouter };

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function authorized(request, env) {
  const expected = env.PULSE_TOKEN;
  if (!expected || typeof expected !== 'string') return false; // fail-closed: no secret configured
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(match[1], expected);
}

function routerStub(env, name) {
  const router = typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : 'global';
  return env.PULSE_ROUTER.get(env.PULSE_ROUTER.idFromName(router));
}

async function callRouter(env, routerName, op, args) {
  const stub = routerStub(env, routerName);
  const res = await stub.fetch('https://pulse-do/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, args }),
  });
  return res;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: true, service: 'pulse' });
    }

    if (!authorized(request, env)) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    if (!env.PULSE_ROUTER) {
      return Response.json({ ok: false, error: 'pulse router binding missing' }, { status: 500 });
    }

    // POST /pulse — emit + subscription management
    if (url.pathname === '/pulse' && request.method === 'POST') {
      const body = await readJson(request);
      const action = body.action || 'route';
      const routerName = body.router || url.searchParams.get('router');
      const opMap = { route: 'route', emit: 'route', subscribe: 'subscribe', unsubscribe: 'unsubscribe', requeue: 'requeue', getSubscriber: 'getSubscriber' };
      const op = opMap[action];
      if (!op) return Response.json({ ok: false, error: 'unknown action' }, { status: 400 });
      const args = op === 'route' ? { event: body.event ?? body } : (body.args ?? body);
      return callRouter(env, routerName, op, args);
    }

    if (url.pathname === '/claim' && request.method === 'POST') {
      const body = await readJson(request);
      return callRouter(env, body.router || url.searchParams.get('router'), 'claim', body.args ?? body);
    }

    if (url.pathname === '/ack' && request.method === 'POST') {
      const body = await readJson(request);
      return callRouter(env, body.router || url.searchParams.get('router'), 'ack', body.args ?? body);
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      const subscriberId = url.searchParams.get('subscriberId');
      const ownerRunId = url.searchParams.get('ownerRunId') || undefined;
      const routerName = url.searchParams.get('router');
      return callRouter(env, routerName, 'status', { subscriberId, ownerRunId });
    }

    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};
