// Pulse Worker — plain HTTP front for the PulseRouter Durable Object.
//
// Routes (all require an authenticated principal bearer token):
//   POST /pulse   -> emit/route a terminal event (also: subscribe/unsubscribe/requeue/prune)
//   POST /claim   -> claim pending mailbox events
//   POST /ack     -> acknowledge an inflight event
//   GET  /status  -> mailbox counts for a subscriber
//
// Round 5C2 authn:
//   Explicit principal-auth: env.TERRARIUM_PRINCIPAL_ID (stable owner identity)
//   plus an INDEPENDENT verification token pair:
//     env.TERRARIUM_PULSE_TOKEN_CURRENT   (required)
//     env.TERRARIUM_PULSE_TOKEN_PREVIOUS  (optional; zero-downtime rotation)
//   Fail-closed. The legacy env.PULSE_TOKEN MUST NOT authorize on the public
//   surface: any request presenting it is refused, so a leaked historical
//   secret cannot bypass the principal-scoped writer contract.
//
// Every authenticated request injects the authenticated principalId into every
// subscribe/get/claim/ack/status/requeue/unsubscribe/prune op, and any client
// ownerId/ownerRunId/principalId claim in the request body is ignored. Public
// route/emit forces event.ownerId to the authenticated principal.
//
// One DO instance per "router" name keeps journal+subscribers+mailboxes colocated
// and serialized. Default name "global"; callers may shard via ?router= / body.router.

import { PulseRouter } from './do.js';
import { authenticatePulseRequest } from '../cloud/principal-auth.js';

export { PulseRouter };

function routerStub(env, name) {
  const router = typeof name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : 'global';
  return env.PULSE_ROUTER.get(env.PULSE_ROUTER.idFromName(router));
}

async function callRouter(env, routerName, op, args, extra = {}) {
  const stub = routerStub(env, routerName);
  const res = await stub.fetch('https://pulse-do/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, args, ...extra }),
  });
  return res;
}

// Round 5C2 anti-enumeration: a public read/settle op that authenticated but
// referred to a missing or cross-principal subscriber/event must not reveal
// the distinction. The DO returns 404 with code=ENOENT for cross-principal
// access (via #assertPrincipal); we also normalize a 403 owned-by-another to
// 404 on the public surface.
async function normalizePublic(response) {
  if (response.status === 403 || response.status === 404) {
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  }
  return response;
}

// Strip every client-supplied ownership claim. Public subscriber ownership is
// exclusively the authenticated stable principal; ownerRunId remains available
// only to direct legacy/test callers of PulseRouter and is never client input.
function scrubClientClaims(args) {
  if (!args || typeof args !== 'object') return {};
  const {
    principalId: _dropPrincipal,
    ownerId: _dropOwner,
    ownerRunId: _dropOwnerRun,
    ...rest
  } = args;
  return rest;
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

    // Round 5C2: principal-scoped bearer auth. Fail-closed on any missing or
    // wrong credential; legacy PULSE_TOKEN alone MUST NOT authorize (the
    // authenticatePulseRequest helper rejects a bearer that matches the
    // legacy secret so a rotation cannot accidentally re-enable it).
    const auth = authenticatePulseRequest(request, env);
    if (!auth.ok) {
      return withCors(Response.json({ ok: false, error: auth.error }, { status: auth.status }), request);
    }
    const principalId = auth.principalId;
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
      if (!op) return withCors(Response.json({ ok: false, error: 'unknown action' }, { status: 400 }), request);
      if (op === 'route') {
        // Round 5C2: the public route/emit path FORCES event.ownerId to the
        // authenticated principal. Any client-supplied ownerId in the event
        // body is discarded — a caller can never emit on behalf of another
        // principal. requirePrincipalOwner=true also causes the DO to reject
        // an event whose (now-injected) ownerId fails the principal regex.
        const rawEvent = body.event ?? body;
        const eventNoClaims = (rawEvent && typeof rawEvent === 'object') ? { ...rawEvent } : {};
        delete eventNoClaims.ownerId;
        delete eventNoClaims.principalId;
        eventNoClaims.ownerId = principalId;
        return withCors(await callRouter(env, routerName, 'route', { event: eventNoClaims }, { requirePrincipalOwner: true }), request);
      }
      // Non-route subscription-management ops: inject authenticated principalId,
      // strip any client claims.
      const rawArgs = body.args ?? body;
      const args = { ...scrubClientClaims(rawArgs), principalId };
      const res = await callRouter(env, routerName, op, args);
      return withCors(await normalizePublic(res), request);
    }

    if (url.pathname === '/claim' && request.method === 'POST') {
      const body = await readJson(request);
      const args = { ...scrubClientClaims(body.args ?? body), principalId };
      const res = await callRouter(env, body.router || url.searchParams.get('router'), 'claim', args);
      return withCors(await normalizePublic(res), request);
    }

    if (url.pathname === '/ack' && request.method === 'POST') {
      const body = await readJson(request);
      const args = { ...scrubClientClaims(body.args ?? body), principalId };
      const res = await callRouter(env, body.router || url.searchParams.get('router'), 'ack', args);
      return withCors(await normalizePublic(res), request);
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      const subscriberId = url.searchParams.get('subscriberId');
      const routerName = url.searchParams.get('router');
      const res = await callRouter(env, routerName, 'status', { subscriberId, principalId });
      return withCors(await normalizePublic(res), request);
    }

    return withCors(Response.json({ ok: false, error: 'not found' }, { status: 404 }), request);
  },
};
