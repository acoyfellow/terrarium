// Unit tests for the SHIPPING PulseRouter Durable Object (src/pulse/do.js).
//
// Round-2 decision (build-loop): we collapsed to ONE tested implementation.
// The non-shipping src/pulse/router-core.js was DELETED (see the round-2 summary)
// because its storage interface { get, put, del, list(prefix) } cannot push
// WHERE state + LIMIT into SQL — claim/status/requeue would degrade to full
// mailbox list-scans. do.js keeps indexed SQL on the hot paths and is the single
// source of truth; all shared pure logic already lives in src/pulse/shared.js
// (imported by both do.js and the fs router), so router-core carried no unique
// logic worth preserving.
//
// These tests drive the DO class DIRECTLY against a SQLite shim that adapts
// node:sqlite (DatabaseSync) onto the Cloudflare `ctx.storage.sql` surface
// (`exec(sql, ...bindings)` returning a cursor with `.toArray()`). They cover the
// happy path, dedup, finish-before-subscribe replay, claim/ack idempotency,
// cross-owner isolation, requeue staleness, PLUS the adversarial cases Dane named.
//
// This is intentionally NOT the Miniflare e2e (test/pulse-e2e.test.js drives the
// real DO+SQLite over HTTP). Here we exercise the class methods in-process so
// adversarial inputs and tampered rows can be injected precisely.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PulseRouter } from '../src/pulse/do.js';

// ---- SQLite shim: node:sqlite -> Cloudflare ctx.storage.sql surface ----
//
// Cloudflare's SqlStorage exposes `exec(sqlString, ...bindings)` returning a
// cursor; do.js only ever calls `.toArray()` on it. node:sqlite uses
// prepare().all()/run(). We adapt: statements with bindings (or any SELECT) go
// through prepare; bare DDL goes through db.exec().
function makeSqlShim() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(sql, ...bindings) {
      const isSelect = /^\s*SELECT/i.test(sql);
      if (bindings.length === 0 && !isSelect) {
        // CREATE TABLE / other DDL with no bindings.
        db.exec(sql);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(sql);
      if (isSelect) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows };
      }
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
    _db: db,
  };
}

// Build a DO instance over a fresh in-memory SQLite, mimicking the ctx the
// Workers runtime hands the DO constructor.
function makeRouter() {
  const sql = makeSqlShim();
  const ctx = { storage: { sql } };
  const router = new PulseRouter(ctx);
  return { router, sql };
}

const OWNER = 'ter_owner1';
const OTHER = 'ter_intruder2';

function terminalEvent(overrides = {}) {
  return {
    type: 'Completed',
    runId: 'ter_run_abc',
    channel: 'default',
    at: '2026-06-27T10:00:00.000Z',
    status: 'done',
    ok: true,
    exitCode: 0,
    ...overrides,
  };
}

// --------------------------- core contract ---------------------------

test('do: happy path emit -> route -> claim -> ack', async () => {
  const { router } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-happy', ownerRunId: OWNER });

  const routed = await router.route(terminalEvent());
  assert.equal(routed.duplicate, false);
  assert.equal(routed.delivered, 1);
  assert.match(routed.eventId, /^evt_[0-9a-f]{32}$/);

  let st = router.status('sub-happy', OWNER);
  assert.deepEqual(st, { subscriberId: 'sub-happy', pending: 1, inflight: 0, acknowledged: 0 });

  const claimed = router.claim({ subscriberId: 'sub-happy', ownerRunId: OWNER });
  assert.equal(claimed.events.length, 1);
  assert.equal(claimed.events[0].eventId, routed.eventId);
  assert.ok(claimed.events[0].claimedAt, 'claimed event carries claimedAt');
  // private/non-allowlisted fields are stripped on the way out.
  assert.equal('status' in claimed.events[0], true); // allowlisted field survives
  assert.equal('output' in claimed.events[0], false);

  st = router.status('sub-happy', OWNER);
  assert.deepEqual(st, { subscriberId: 'sub-happy', pending: 0, inflight: 1, acknowledged: 0 });

  const acked = router.ack({ subscriberId: 'sub-happy', eventId: routed.eventId, ownerRunId: OWNER });
  assert.equal(acked.acknowledged, true);
  assert.notEqual(acked.duplicate, true);

  st = router.status('sub-happy', OWNER);
  assert.deepEqual(st, { subscriberId: 'sub-happy', pending: 0, inflight: 0, acknowledged: 1 });
});

test('do: route strips private fields before journaling/delivery', async () => {
  const { router } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-strip', ownerRunId: OWNER });
  await router.route(terminalEvent({ task: 'secret prompt', output: 'secret output' }));
  const claimed = router.claim({ subscriberId: 'sub-strip', ownerRunId: OWNER });
  assert.equal(claimed.events.length, 1);
  assert.equal('task' in claimed.events[0], false);
  assert.equal('output' in claimed.events[0], false);
});

test('do: duplicate emit is deduped (same eventId, no second delivery)', async () => {
  const { router } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-dedup', ownerRunId: OWNER });

  const first = await router.route(terminalEvent());
  const second = await router.route(terminalEvent());

  assert.equal(first.duplicate, false);
  assert.equal(first.delivered, 1);
  assert.equal(second.duplicate, true);
  assert.equal(second.delivered, 0);
  assert.equal(second.eventId, first.eventId);

  const st = router.status('sub-dedup', OWNER);
  assert.equal(st.pending, 1, 'mailbox holds exactly one copy after duplicate emit');
});

test('do: finish-before-subscribe replays journal for concrete runIds', async () => {
  const { router } = makeRouter();

  const routed = await router.route(terminalEvent({ runId: 'ter_late_run' }));
  assert.equal(routed.delivered, 0, 'no subscriber yet');

  const sub = await router.subscribe({
    subscriberId: 'sub-late',
    ownerRunId: OWNER,
    runIds: ['ter_late_run'],
  });
  assert.equal(sub.replayed, 1, 'journal replayed the finished event');

  const claimed = router.claim({ subscriberId: 'sub-late', ownerRunId: OWNER });
  assert.equal(claimed.events.length, 1);
  assert.equal(claimed.events[0].runId, 'ter_late_run');

  // Wildcard subscriber must NOT replay history.
  await router.route(terminalEvent({ runId: 'ter_history', at: '2026-06-27T09:00:00.000Z' }));
  const wild = await router.subscribe({ subscriberId: 'sub-wild', ownerRunId: OWNER });
  assert.equal(wild.replayed, 0, 'wildcard subscriber does not replay journal history');
});

test('do: claim then ack is idempotent', async () => {
  const { router } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-idem', ownerRunId: OWNER });
  const routed = await router.route(terminalEvent());

  router.claim({ subscriberId: 'sub-idem', ownerRunId: OWNER });
  const reclaim = router.claim({ subscriberId: 'sub-idem', ownerRunId: OWNER });
  assert.equal(reclaim.events.length, 0, 'inflight event is not re-claimed');

  const firstAck = router.ack({ subscriberId: 'sub-idem', eventId: routed.eventId, ownerRunId: OWNER });
  assert.equal(firstAck.acknowledged, true);
  assert.notEqual(firstAck.duplicate, true);

  const secondAck = router.ack({ subscriberId: 'sub-idem', eventId: routed.eventId, ownerRunId: OWNER });
  assert.equal(secondAck.acknowledged, true);
  assert.equal(secondAck.duplicate, true, 'second ack is idempotent (duplicate:true)');

  const st = router.status('sub-idem', OWNER);
  assert.deepEqual(st, { subscriberId: 'sub-idem', pending: 0, inflight: 0, acknowledged: 1 });
});

test('do: cross-owner cannot claim/ack/status another owner mailbox', async () => {
  const { router } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-owned', ownerRunId: OWNER });
  const routed = await router.route(terminalEvent());

  assert.throws(() => router.claim({ subscriberId: 'sub-owned', ownerRunId: OTHER }), /access denied/);
  assert.throws(() => router.status('sub-owned', OTHER), /access denied/);

  // A controller (no owner) also cannot touch an owned mailbox.
  assert.throws(() => router.claim({ subscriberId: 'sub-owned' }), /access denied/);

  router.claim({ subscriberId: 'sub-owned', ownerRunId: OWNER });
  assert.throws(() => router.ack({ subscriberId: 'sub-owned', eventId: routed.eventId, ownerRunId: OTHER }), /access denied/);

  await assert.rejects(
    () => router.subscribe({ subscriberId: 'sub-owned', ownerRunId: OTHER }),
    /owned by another run or controller/,
  );

  const acked = router.ack({ subscriberId: 'sub-owned', eventId: routed.eventId, ownerRunId: OWNER });
  assert.equal(acked.acknowledged, true);
});

test('do: requeue moves stale inflight and leaves not-yet-stale alone', async () => {
  const { router } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-requeue', ownerRunId: OWNER });
  await router.route(terminalEvent());
  router.claim({ subscriberId: 'sub-requeue', ownerRunId: OWNER });

  // Not-yet-stale: a huge olderThanMs threshold must NOT requeue a fresh claim.
  const noop = router.requeue({ subscriberId: 'sub-requeue', olderThanMs: 3_600_000, ownerRunId: OWNER });
  assert.equal(noop.requeued, 0, 'fresh inflight is not requeued');
  let st = router.status('sub-requeue', OWNER);
  assert.deepEqual(st, { subscriberId: 'sub-requeue', pending: 0, inflight: 1, acknowledged: 0 });

  // Stale: olderThanMs:0 requeues regardless of age.
  const res = router.requeue({ subscriberId: 'sub-requeue', olderThanMs: 0, ownerRunId: OWNER });
  assert.equal(res.requeued, 1);
  st = router.status('sub-requeue', OWNER);
  assert.deepEqual(st, { subscriberId: 'sub-requeue', pending: 1, inflight: 0, acknowledged: 0 });

  const claimed = router.claim({ subscriberId: 'sub-requeue', ownerRunId: OWNER });
  assert.equal(claimed.events.length, 1, 'requeued event is claimable again (claimedAt dropped)');
});

// --------------------------- adversarial cases (Dane) ---------------------------

test('do(adversarial): malformed / non-terminal events are rejected by route', async () => {
  const { router } = makeRouter();

  // non-terminal type
  await assert.rejects(() => router.route(terminalEvent({ type: 'Heartbeat' })), /invalid callback event/);
  // missing runId
  await assert.rejects(() => router.route(terminalEvent({ runId: undefined })), /invalid callback event/);
  // non-string runId
  await assert.rejects(() => router.route(terminalEvent({ runId: 123 })), /invalid callback event/);
  // malformed (non-ISO) timestamp
  await assert.rejects(() => router.route(terminalEvent({ at: '2026-06-27 10:00:00' })), /invalid callback event timestamp/);
  // non-canonical ISO (no millis) must also fail the strict timestamp check
  await assert.rejects(() => router.route(terminalEvent({ at: '2026-06-27T10:00:00Z' })), /invalid callback event timestamp/);
});

test('do(adversarial): oversized / unbounded subscription filter is rejected', async () => {
  const { router } = makeRouter();
  // boundedList rejects > 100 entries.
  const huge = Array.from({ length: 101 }, (_, i) => `ter_run_${i}`);
  await assert.rejects(
    () => router.subscribe({ subscriberId: 'sub-huge', ownerRunId: OWNER, runIds: huge }),
    /invalid subscription filter/,
  );
  // an over-long single filter entry (>200 chars) is also rejected.
  await assert.rejects(
    () => router.subscribe({ subscriberId: 'sub-long', ownerRunId: OWNER, channels: ['x'.repeat(201)] }),
    /invalid subscription filter/,
  );
});

test('do(adversarial): ack of an unclaimed (pending) event throws', async () => {
  const { router } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-pending', ownerRunId: OWNER });
  const routed = await router.route(terminalEvent());
  // event is pending, never claimed -> ack must reject (not silently succeed).
  assert.throws(
    () => router.ack({ subscriberId: 'sub-pending', eventId: routed.eventId, ownerRunId: OWNER }),
    /event is not inflight/,
  );
  // and it stays pending.
  assert.deepEqual(router.status('sub-pending', OWNER), { subscriberId: 'sub-pending', pending: 1, inflight: 0, acknowledged: 0 });
});

test('do(adversarial): ack of a nonexistent eventId throws', async () => {
  const { router } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-ghost', ownerRunId: OWNER });
  assert.throws(
    () => router.ack({ subscriberId: 'sub-ghost', eventId: 'evt_does_not_exist', ownerRunId: OWNER }),
    /event is not inflight/,
  );
});

test('do(adversarial): pi-* / pi_ wildcard subscriber holding "*" runId receives NO delivery', async () => {
  const { router } = makeRouter();
  // pi-* subscriber with wildcard runIds -> the matches() guard suppresses
  // delivery so a routed event never wakes a sibling Pi session.
  await router.subscribe({ subscriberId: 'pi-session-host', ownerRunId: OWNER, runIds: ['*'] });
  await router.subscribe({ subscriberId: 'pi_other_host', ownerRunId: OWNER, runIds: ['*'] });
  // a normal wildcard subscriber DOES receive it (control).
  await router.subscribe({ subscriberId: 'normal-wild', ownerRunId: OWNER, runIds: ['*'] });

  const routed = await router.route(terminalEvent());
  assert.equal(routed.delivered, 1, 'only the non-pi wildcard subscriber is delivered to');

  assert.deepEqual(router.status('pi-session-host', OWNER), { subscriberId: 'pi-session-host', pending: 0, inflight: 0, acknowledged: 0 });
  assert.deepEqual(router.status('pi_other_host', OWNER), { subscriberId: 'pi_other_host', pending: 0, inflight: 0, acknowledged: 0 });
  assert.equal(router.status('normal-wild', OWNER).pending, 1);

  // But a pi-* subscriber with a CONCRETE runId is allowed (explicit target).
  // Subscribing with a concrete runId also replays the matching journaled event
  // (the first route above), so it sees 1 replayed; a second route adds 1 more.
  const piSub = await router.subscribe({ subscriberId: 'pi-concrete', ownerRunId: OWNER, runIds: ['ter_run_abc'] });
  assert.equal(piSub.replayed, 1, 'pi-* with concrete runId replays the matching journaled event');
  const routed2 = await router.route(terminalEvent({ at: '2026-06-27T11:00:00.000Z' }));
  assert.ok(routed2.delivered >= 1);
  assert.equal(router.status('pi-concrete', OWNER).pending, 2, 'pi-* with concrete runId is delivered to (1 replayed + 1 routed)');
});

test('do(adversarial): getSubscriber fails closed on a tampered owner_run_id before owner check', async () => {
  const { router, sql } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-tamper', ownerRunId: OWNER });
  // Corrupt the stored owner_run_id directly in the table to a non-canonical value.
  sql._db.prepare("UPDATE subscribers SET owner_run_id = ? WHERE subscriber_id = ?")
    .run('not-a-valid-owner', 'sub-tamper');
  assert.throws(() => router.getSubscriber('sub-tamper'), /invalid callback subscriber record/);
  // downstream ops that load the subscriber also fail closed.
  assert.throws(() => router.status('sub-tamper', OWNER), /invalid callback subscriber record/);
});

test('do(adversarial): getSubscriber fails closed on a malformed updatedAt timestamp', async () => {
  const { router, sql } = makeRouter();
  await router.subscribe({ subscriberId: 'sub-ts', ownerRunId: OWNER });
  sql._db.prepare("UPDATE subscribers SET updated_at = ? WHERE subscriber_id = ?")
    .run('2026-06-27 10:00:00', 'sub-ts');
  assert.throws(() => router.getSubscriber('sub-ts'), /invalid callback subscriber record/);
});
