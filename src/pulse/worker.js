// Pulse Worker — plain HTTP front for the PulseRouter Durable Object.
//
// Routes (all require a capability bearer token):
//   POST /pulse   -> emit/route a terminal event (also: subscribe/unsubscribe/requeue/prune)
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

// CORS for browser/webview consumers (mote runs in a WKWebView and does a
// real cross-origin fetch from its dev-server origin). This is a
// capability-token API: the bearer token is the security boundary, not the
// origin, so reflecting any origin is safe here — a hostile page still cannot
// read the token, and every request must present it. We echo the request
// origin (falling back to *) and allow the auth/content-type headers.
function corsHeaders(request) {
  const origin = request.headers.get('origin') || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

// Re-emit a Response with CORS headers merged in (Response headers are
// immutable, so we copy). Used to wrap both local and DO-proxied responses.
function withCors(response, request) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight must be answered BEFORE the auth gate — browsers send
    // OPTIONS with no credentials, so gating it 401 breaks every cross-origin
    // consumer (this was why mote showed "unavailable").
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return withCors(Response.json({ ok: true, service: 'pulse' }), request);
    }

    if (!authorized(request, env)) {
      return withCors(Response.json({ ok: false, error: 'unauthorized' }, { status: 401 }), request);
    }
    if (!env.PULSE_ROUTER) {
      return withCors(Response.json({ ok: false, error: 'pulse router binding missing' }, { status: 500 }), request);
    }

    // POST /pulse — emit + subscription management
    if (url.pathname === '/pulse' && request.method === 'POST') {
      const body = await readJson(request);
      const action = body.action || 'route';
      const routerName = body.router || url.searchParams.get('router');
      const opMap = { route: 'route', emit: 'route', subscribe: 'subscribe', unsubscribe: 'unsubscribe', requeue: 'requeue', prune: 'prune', getSubscriber: 'getSubscriber' };
      const op = opMap[action];
      if (!op) return Response.json({ ok: false, error: 'unknown action' }, { status: 400 });
      const args = op === 'route' ? { event: body.event ?? body } : (body.args ?? body);
      return withCors(await callRouter(env, routerName, op, args), request);
    }

    if (url.pathname === '/claim' && request.method === 'POST') {
      const body = await readJson(request);
      return withCors(await callRouter(env, body.router || url.searchParams.get('router'), 'claim', body.args ?? body), request);
    }

    if (url.pathname === '/ack' && request.method === 'POST') {
      const body = await readJson(request);
      return withCors(await callRouter(env, body.router || url.searchParams.get('router'), 'ack', body.args ?? body), request);
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      const subscriberId = url.searchParams.get('subscriberId');
      const ownerRunId = url.searchParams.get('ownerRunId') || undefined;
      const routerName = url.searchParams.get('router');
      return withCors(await callRouter(env, routerName, 'status', { subscriberId, ownerRunId }), request);
    }

    return withCors(Response.json({ ok: false, error: 'not found' }, { status: 404 }), request);
  },
};
