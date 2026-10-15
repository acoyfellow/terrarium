import { client, writeReceipt } from "./lib.mjs";

const api = client();
const started = Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const create = async (body) => {
  const { status, json } = await api.call("/api/loops", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });

  if (status !== 202) throw new Error(`loop ${status} ${JSON.stringify(json)}`);

  return json;
};

const loopOf = async (loopId) => {
  const { json } = await api.call(`/api/loops/${loopId}`);

  return json.loop ?? json;
};

const until = async (loopId, predicate, polls = 120) => {
  for (let poll = 0; poll < polls; poll += 1) {
    const loop = await loopOf(loopId);

    if (predicate(loop)) return loop;

    await sleep(5000);
  }

  return loopOf(loopId);
};

const secretWord = `ostrich-${Math.floor(Math.random() * 9000 + 1000)}`;
const eventLoop = await create({ goal: "borrow 09 event wake", task: "Reply with the secret word from the wake note below. If there is no wake note yet, reply with exactly: no word yet.", expect: secretWord, maxAttempts: 2, wake: { on: "event", timeout: "30 minutes" } });

const afterFirst = await until(eventLoop.loopId, (loop) => (loop.output?.attempts?.length ?? 0) >= 1 || loop.status === "waiting" || loop.status === "complete", 60);
await sleep(20_000);
const stillWaiting = await loopOf(eventLoop.loopId);
const waitingStatus = stillWaiting.status;

const hookPath = eventLoop.hook ?? null;
const wakeStarted = Date.now();
const otherOwner = await api.call(`/api/loops/loop_00000000000000000000000000000000/wake`, { method: "POST", body: "{}" });
const wakeResponse = await api.call(`/api/loops/${eventLoop.loopId}/wake`, { method: "POST", body: JSON.stringify({ source: "ci", note: `the secret word is ${secretWord}` }) });
const publicHook = hookPath === null ? { status: 0, redirected: false } : await fetch(new URL(hookPath, api.url), { method: "POST", redirect: "manual", body: "{}" });

const finished = await until(eventLoop.loopId, (loop) => loop.output !== null && loop.output !== undefined, 120);
const wakeSeconds = Math.round((Date.now() - wakeStarted) / 1000);
const attempts = finished.output?.attempts ?? [];

const timerLoop = await create({ goal: "borrow 09 timer wake", task: "Reply with exactly: tick", expect: "never-matches", maxAttempts: 2, wake: { every: "30 seconds" } });
const timerDone = await until(timerLoop.loopId, (loop) => loop.output !== null && loop.output !== undefined, 120);
const timerWakes = timerDone.output?.wakes ?? [];

await Promise.all([eventLoop.loopId, timerLoop.loopId].map((id) => api.call(`/api/loops/${id}`, { method: "DELETE" })));

const results = [
  { name: "an event-wake loop sleeps after a failed attempt instead of retrying", ok: attempts.length === 2 && attempts[0]?.gate?.passed === false && waitingStatus !== "complete", note: `status while asleep: ${waitingStatus}; first attempt: ${attempts[0]?.gate?.reason}` },
  { name: "the owner (or CI with an Access service token) wakes it with a note", ok: wakeResponse.status === 202, note: `wake ${wakeResponse.status}` },
  { name: "waking a loop you do not own is refused", ok: otherOwner.status === 404, note: `other ${otherOwner.status}` },
  { name: "the woken attempt received the wake note and passed", ok: attempts[1]?.gate?.passed === true && finished.output?.decision?.outcome === "passed", note: `${finished.output?.decision?.outcome} in ${wakeSeconds}s after the hook; wakes=${JSON.stringify(finished.output?.wakes)}` },
  { name: "a timer-wake loop sleeps its interval between attempts", ok: (timerDone.output?.attempts?.length ?? 0) === 2 && timerWakes.length === 1 && timerWakes[0] === null, note: `attempts=${timerDone.output?.attempts?.length} wakes=${JSON.stringify(timerWakes)}` },
];

const hookStatus = { path: hookPath === null ? null : hookPath.replace(/sig=[0-9a-f]+/, "sig=<redacted>"), unauthenticatedStatus: publicHook.status, blockedBy: publicHook.status === 302 ? "Cloudflare Access covers every path; /hooks/* needs an Access bypass policy (owner decision)" : null };

writeReceipt(9, { hookStatus, title: "event wakes: a loop sleeps in Workflows (waitForEvent or a timer) and a signed hook or the owner wakes it with a note", seconds: Math.round((Date.now() - started) / 1000), loops: [eventLoop.loopId, timerLoop.loopId], ok: results.every((r) => r.ok), results, firstAttemptsSeen: afterFirst?.output?.attempts?.length ?? 0 });
