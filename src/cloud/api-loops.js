import { authenticateOwner } from "./web-session.js";
import { validateContract } from "./loop-decide.js";

const LOOP_ID_RE = /^loop_[a-z0-9]{8,40}$/;
const OWNER_KEY_PREFIX = "loops:";
const LIST_LIMIT = 50;

function ownerSlug(ownerId) {
  return encodeURIComponent(ownerId);
}

function loopKey(ownerId, loopId) {
  return `${OWNER_KEY_PREFIX}${ownerSlug(ownerId)}:${loopId}`;
}

function mintLoopId() {
  const stamp = Date.now().toString(36);
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return `loop_${stamp}${random}`;
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function witness(env, record) {
  try {
    const instance = await env.TERRARIUM_LOOP.get(record.loopId);
    const status = await instance.status();
    return { ...record, workflow: status };
  } catch (error) {
    return { ...record, workflow: { status: "unknown", error: String(error?.message ?? error) } };
  }
}

export async function handleApiLoops(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/loops")) return null;
  if (!env.TERRARIUM_LOOP || !env.TERRARIUM_LEDGER) return Response.json({ ok: false, error: "loops are not configured" }, { status: 503 });

  const auth = await authenticateOwner(request, env);
  if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: auth.status });
  const ownerId = auth.principalId;

  if (url.pathname === "/api/loops" && request.method === "POST") {
    const verdict = validateContract(await readJson(request));
    if (!verdict.ok) return Response.json({ ok: false, problems: verdict.problems }, { status: 400 });
    const loopId = mintLoopId();
    const record = { loopId, ownerId, contract: verdict.contract, lockedAt: new Date().toISOString() };
    await env.TERRARIUM_LEDGER.put(loopKey(ownerId, loopId), JSON.stringify(record));
    await env.TERRARIUM_LOOP.create({ id: loopId, params: { loopId, ownerId, contract: verdict.contract } });
    return Response.json({ ok: true, loopId, contract: verdict.contract }, { status: 202 });
  }

  if (url.pathname === "/api/loops" && request.method === "GET") {
    const listed = await env.TERRARIUM_LEDGER.list({ prefix: `${OWNER_KEY_PREFIX}${ownerSlug(ownerId)}:`, limit: LIST_LIMIT });
    const records = (await Promise.all(listed.keys.map((k) => env.TERRARIUM_LEDGER.get(k.name, "json")))).filter(Boolean);
    records.sort((a, b) => b.lockedAt.localeCompare(a.lockedAt));
    return Response.json({ ok: true, loops: await Promise.all(records.map((r) => witness(env, r))) });
  }

  const match = url.pathname.match(/^\/api\/loops\/([^/]+)$/);
  if (match && request.method === "GET") {
    if (!LOOP_ID_RE.test(match[1])) return Response.json({ ok: false, error: "invalid loop id" }, { status: 400 });
    const record = await env.TERRARIUM_LEDGER.get(loopKey(ownerId, match[1]), "json");
    if (!record) return Response.json({ ok: false, error: "not found" }, { status: 404 });
    return Response.json({ ok: true, loop: await witness(env, record) });
  }

  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}
