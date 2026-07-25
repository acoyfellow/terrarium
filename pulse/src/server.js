// Pulse server — a Hono app exposing the router over HTTP. The same app object
// runs under Node (`npm start`, via @hono/node-server) and is a drop-in
// Worker-compatible `fetch` handler (`export default app`), matching the
// Terrarium Cloudflare Worker route surface:
//
//   GET  /health   -> liveness, no auth
//   POST /pulse    -> route/subscribe/unsubscribe/requeue/prune (action in body)
//   POST /claim    -> claim pending mailbox events
//   POST /ack      -> acknowledge an inflight event
//   GET  /status   -> mailbox counts for a subscriber
//
// Authz: Bearer token compared (length-safe) against PULSE_TOKEN. Fail-closed —
// a missing request token OR a missing configured token is 401. For local e2e
// PULSE_TOKEN defaults to "local-dev" so the docs demo works out of the box; set
// the env var to override. Never hard-code a real secret here.

import { Hono } from 'hono';
import { PulseRouter } from './router.js';

const DEFAULT_TOKEN = 'local-dev';

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

// Build a Hono app over a given router instance + token. Exported so tests and
// the e2e script can inject a fresh in-memory router and a known token.
export function createApp({ router = new PulseRouter(), token } = {}) {
  const app = new Hono();
  const expected = token ?? process.env?.PULSE_TOKEN ?? DEFAULT_TOKEN;

  const authorized = (c) => {
    if (!expected || typeof expected !== 'string') return false;
    const header = c.req.header('authorization') || '';
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match) return false;
    return timingSafeEqual(match[1], expected);
  };

  app.get('/health', (c) => c.json({ ok: true, service: 'pulse' }));

  // Auth gate for everything else.
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    if (!authorized(c)) return c.json({ ok: false, error: 'unauthorized' }, 401);
    return next();
  });

  const run = async (c, fn) => {
    try {
      const result = await fn();
      return c.json({ ok: true, result });
    } catch (error) {
      const denied = /access denied|owned by another/.test(error.message);
      const notFound = error.code === 'ENOENT';
      const status = denied ? 403 : notFound ? 404 : 400;
      return c.json({ ok: false, error: error.message }, status);
    }
  };

  const ACTIONS = {
    route: (b) => router.route(b.event ?? b),
    emit: (b) => router.route(b.event ?? b),
    subscribe: (b) => router.subscribe(b.args ?? b),
    unsubscribe: (b) => router.unsubscribe((b.args ?? b).subscriberId, (b.args ?? b).ownerRunId),
    requeue: (b) => router.requeue(b.args ?? b),
    prune: (b) => router.prune(b.args ?? b),
    getSubscriber: (b) => router.getSubscriber((b.args ?? b).subscriberId),
  };

  app.post('/pulse', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = body.action || 'route';
    const handler = ACTIONS[action];
    if (!handler) return c.json({ ok: false, error: 'unknown action' }, 400);
    return run(c, () => handler(body));
  });

  app.post('/claim', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return run(c, () => router.claim(body.args ?? body));
  });

  app.post('/ack', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return run(c, () => router.ack(body.args ?? body));
  });

  app.get('/status', async (c) => {
    const subscriberId = c.req.query('subscriberId');
    const ownerRunId = c.req.query('ownerRunId') || undefined;
    return run(c, () => router.status(subscriberId, ownerRunId));
  });

  app.notFound((c) => c.json({ ok: false, error: 'not found' }, 404));
  app.pulseRouter = router;
  return app;
}

// Default export is a Worker-compatible fetch app over a module-singleton router.
const app = createApp();
export default app;
