<script>
  // The demo runs the real in-memory PulseRouter in the browser, so the buttons
  // below exercise the actual subscribe/emit/claim/ack protocol — the same code
  // the tests and the Cloudflare Worker use. This page dogfoods Pulse on itself.
  import { PulseRouter } from '../../src/router.js';

  const SUBSCRIBER = 'docs-consumer';
  const CHANNEL = 'docs';
  const router = new PulseRouter();

  let log = [];
  let counts = { pending: 0, inflight: 0, acknowledged: 0, dead: 0 };
  let subscribed = false;
  let lastEventId = null;
  let claimedId = null;

  function note(msg, ok = false) {
    log = [{ ts: new Date().toISOString().slice(11, 23), msg, ok }, ...log].slice(0, 50);
  }
  function refresh() {
    try { counts = router.status(SUBSCRIBER); } catch { /* not subscribed yet */ }
  }

  async function subscribe() {
    const sub = await router.subscribe({ subscriberId: SUBSCRIBER, channels: [CHANNEL] });
    subscribed = true;
    note(`subscribed "${sub.subscriberId}" on channel [${CHANNEL}]`);
    refresh();
  }

  async function emit() {
    const res = await router.route({
      type: 'Completed', runId: 'ter_docs_smoke', channel: CHANNEL,
      at: new Date().toISOString(), status: 'docs-smoke', exitCode: 0, ok: true,
      receipt: { artifact: 'docs', note: 'docs build smoke' },
    });
    lastEventId = res.eventId;
    note(`emit -> ${res.eventId} (delivered ${res.delivered}${res.duplicate ? ', duplicate' : ''})`);
    refresh();
  }

  function claim() {
    const res = router.claim({ subscriberId: SUBSCRIBER });
    if (!res.events.length) { note('claim -> nothing pending'); return; }
    claimedId = res.events[0].eventId;
    note(`claim -> ${claimedId} now inflight`);
    refresh();
  }

  function ack() {
    if (!claimedId) { note('ack -> nothing claimed'); return; }
    const res = router.ack({ subscriberId: SUBSCRIBER, eventId: claimedId });
    note(`ack -> ${claimedId} acknowledged`, true);
    claimedId = null;
    refresh();
  }
</script>

<main>
  <h1>Pulse <span class="tag">// durable callbacks</span></h1>
  <p class="pitch">
    Durable callback plumbing for delegated work. Emit a terminal event, journal and
    dedupe it, fan out to subscribers, claim it later, ack after handling. Not a
    workflow engine, not memory, not proof — just the plumbing.
  </p>

  <div class="steps">
    <span>1 · subscribe</span><span>2 · emit</span><span>3 · claim</span><span>4 · ack</span>
  </div>

  <section class="demo">
    <div class="controls">
      <button on:click={subscribe} disabled={subscribed}>subscribe</button>
      <button on:click={emit} disabled={!subscribed}>emit docs event</button>
      <button on:click={claim} disabled={!subscribed}>claim</button>
      <button class="primary" on:click={ack} disabled={!claimedId}>ack</button>
    </div>

    <div class="counts">
      <span>pending <b>{counts.pending}</b></span>
      <span>inflight <b>{counts.inflight}</b></span>
      <span class="ack">acked <b>{counts.acknowledged}</b></span>
    </div>

    <div class="log">
      {#if log.length === 0}
        <span class="empty">Press subscribe to begin — this runs the real router in your browser.</span>
      {:else}
        {#each log as row}
          <div class="row"><span class="ts">{row.ts}</span> <span class:ok={row.ok}>{row.msg}</span></div>
        {/each}
      {/if}
    </div>
  </section>

  <footer>
    Extracted from <a href="https://github.com/">Terrarium</a> Pulse. The browser demo,
    the Hono server, and the tests all share <code>src/router.js</code> and
    <code>src/schema.js</code>.
  </footer>
</main>
