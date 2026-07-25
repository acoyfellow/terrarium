#!/usr/bin/env node
// Docs dogfood e2e — Pulse used on itself.
//
// 1. Subscribe a docs consumer on the 'docs' channel.
// 2. Emit a terminal docs-smoke event (the "docs build finished" callback).
// 3. The consumer claims the event.
// 4. The consumer acks it.
// 5. Print the event + ack state.
//
// Runs against the in-memory router (no deploy, no network), but uses the exact
// emit/claim/ack protocol the Cloudflare Worker/DO exposes, so this is a real
// end-to-end exercise of the callback plumbing on Pulse's own docs signal.

import { PulseRouter } from '../src/router.js';

const SUBSCRIBER = 'docs-consumer';
const CHANNEL = 'docs';

function line(label, value) {
  console.log(`${label.padEnd(14)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function main() {
  const router = new PulseRouter();
  console.log('— Pulse docs dogfood e2e —\n');

  // 1. subscribe
  const sub = await router.subscribe({ subscriberId: SUBSCRIBER, channels: [CHANNEL] });
  line('subscribed', { subscriberId: sub.subscriberId, channels: sub.channels });

  // 2. emit a terminal docs-smoke event
  const routed = await router.route({
    type: 'Completed',
    runId: 'ter_docs_smoke',
    channel: CHANNEL,
    at: new Date().toISOString(),
    status: 'docs-smoke',
    exitCode: 0,
    ok: true,
    receipt: { artifact: 'README + demo', note: 'docs build smoke' },
  });
  line('emitted', { eventId: routed.eventId, delivered: routed.delivered });

  // 3. claim
  const claim = router.claim({ subscriberId: SUBSCRIBER });
  if (claim.events.length !== 1) throw new Error(`expected 1 claimed event, got ${claim.events.length}`);
  const event = claim.events[0];
  line('claimed', { eventId: event.eventId, type: event.type, claimedAt: event.claimedAt });

  // 4. ack
  const ack = router.ack({ subscriberId: SUBSCRIBER, eventId: event.eventId });
  line('acked', ack);

  // 5. final mailbox state
  const status = router.status(SUBSCRIBER);
  line('status', status);

  console.log('');
  const pass = routed.delivered === 1 && ack.acknowledged === true &&
    status.acknowledged === 1 && status.pending === 0 && status.inflight === 0;
  if (!pass) {
    console.error('DOGFOOD FAIL: unexpected final state');
    process.exit(1);
  }
  console.log('DOGFOOD PASS: emit -> claim -> ack settled on the docs channel.');
}

main().catch((err) => { console.error('DOGFOOD ERROR:', err.message); process.exit(1); });
