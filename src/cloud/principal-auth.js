// Principal auth for the Cloud Terrarium /api/runs surface.
//
// Round 5C1: replaces the legacy "bearer-token becomes owner via SHA-256"
// scheme with an explicit, fail-closed principal identity + independent
// verification tokens.
//
// Contract:
//   * env.TERRARIUM_PRINCIPAL_ID       — REQUIRED, non-empty. This is the
//                                        stable owner identity. Never derived
//                                        from the token, never accepted from
//                                        the client body.
//   * env.TERRARIUM_CONTROL_TOKEN_CURRENT — REQUIRED, non-empty. Current
//                                        verification token. Compared
//                                        constant-time against the bearer.
//   * env.TERRARIUM_CONTROL_TOKEN_PREVIOUS — OPTIONAL. Second acceptable
//                                        token for zero-downtime rotation.
//                                        Same principal maps regardless of
//                                        which token authenticated.
//
// Legacy env.TERRARIUM_CONTROL_TOKEN is NOT accepted here — /api/runs must
// only authorize on the explicit CURRENT/PREVIOUS variables. Legacy usage
// remains valid for the campaign control routes only.
//
// The client MUST NOT supply an ownerId field: any client-provided owner is
// ignored and the principal from env takes over.

const encoder = new TextEncoder();
const PRINCIPAL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function constantTimeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < length; i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

function constantTimeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return constantTimeEqualBytes(encoder.encode(a), encoder.encode(b));
}

function extractBearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? match[1] : null;
}

/**
 * Generalized principal-auth check against a chosen pair of verification token
 * env variables. Shared by /api/runs (control tokens) and the Pulse public
 * worker (pulse tokens). Fail-closed on any missing/wrong config.
 *
 * Never leaks which of PRINCIPAL_ID / CURRENT / PREVIOUS was missing; all
 * misconfigurations and mismatches surface as generic 401.
 */
function authenticateWithTokens(request, env, currentKey, previousKey, { rejectTokenKey } = {}) {
  const principalId = typeof env?.TERRARIUM_PRINCIPAL_ID === "string" ? env.TERRARIUM_PRINCIPAL_ID : "";
  const current = typeof env?.[currentKey] === "string" ? env[currentKey] : "";
  const previous = typeof env?.[previousKey] === "string" ? env[previousKey] : "";

  // Fail closed on any missing required config. Empty strings are treated as
  // missing — never authorize against an empty token.
  if (!PRINCIPAL_ID_RE.test(principalId) || !current) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const presented = extractBearer(request);
  if (!presented) return { ok: false, status: 401, error: "unauthorized" };

  // Reject legacy tokens outright: if a rejectTokenKey is configured AND its
  // value matches, refuse to authorize. Doing this constant-time keeps the
  // check timing-uniform, but it never grants a session.
  let matchedLegacy = false;
  if (rejectTokenKey) {
    const legacy = typeof env?.[rejectTokenKey] === "string" ? env[rejectTokenKey] : "";
    if (legacy) matchedLegacy = constantTimeEqualStr(presented, legacy);
  }
  // Constant-time compare against BOTH acceptable tokens; do not short-circuit
  // on the first match. Evaluate both branches so the timing signal does not
  // reveal which token authenticated.
  const matchCurrent = constantTimeEqualStr(presented, current);
  const matchPrevious = previous ? constantTimeEqualStr(presented, previous) : false;
  if (!(matchCurrent || matchPrevious) || matchedLegacy) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true, principalId };
}

/**
 * Authenticate a request against the explicit principal-auth env. Returns
 * { ok: true, principalId } on success. On failure returns
 * { ok: false, status, error } — always fail-closed.
 */
function parsePrincipalDirectory(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, status: 401, error: "unauthorized" }; }
  if (!Array.isArray(parsed) || parsed.length === 0) return { ok: false, status: 401, error: "unauthorized" };
  const entries = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") return { ok: false, status: 401, error: "unauthorized" };
    const id = typeof row.id === "string" ? row.id : "";
    const token = typeof row.token === "string" ? row.token : "";
    const previous = typeof row.previous === "string" ? row.previous : "";
    if (!PRINCIPAL_ID_RE.test(id) || !token) return { ok: false, status: 401, error: "unauthorized" };
    entries.push({ id, token, previous });
  }
  return { ok: true, entries };
}

function authenticateFromDirectory(request, directory) {
  const presented = extractBearer(request);
  if (!presented) return { ok: false, status: 401, error: "unauthorized" };
  let matchedId = "";
  let matches = 0;
  for (const entry of directory.entries) {
    const hit = constantTimeEqualStr(presented, entry.token) || (entry.previous ? constantTimeEqualStr(presented, entry.previous) : false);
    if (hit) {
      matches += 1;
      matchedId = entry.id;
    }
  }
  if (matches !== 1) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true, principalId: matchedId };
}

export function authenticatePrincipal(request, env) {
  const directory = parsePrincipalDirectory(env?.TERRARIUM_PRINCIPALS);
  if (directory) {
    if (directory.ok === false) return directory;
    return authenticateFromDirectory(request, directory);
  }
  return authenticateWithTokens(request, env, "TERRARIUM_CONTROL_TOKEN_CURRENT", "TERRARIUM_CONTROL_TOKEN_PREVIOUS");
}

/**
 * Round 5C2: Authenticate a Pulse public-surface request. Requires the same
 * bounded TERRARIUM_PRINCIPAL_ID plus an INDEPENDENT verification token pair
 * (TERRARIUM_PULSE_TOKEN_CURRENT plus optional TERRARIUM_PULSE_TOKEN_PREVIOUS).
 *
 * The legacy env.PULSE_TOKEN MUST NOT authorize here: it is a distinct
 * historical bearer used only by unauthenticated automation and any request
 * presenting it is refused. Existing single-token Pulse deployments must
 * migrate to TERRARIUM_PULSE_TOKEN_CURRENT.
 */
export function authenticatePulseRequest(request, env) {
  return authenticateWithTokens(request, env,
    "TERRARIUM_PULSE_TOKEN_CURRENT",
    "TERRARIUM_PULSE_TOKEN_PREVIOUS",
    { rejectTokenKey: "PULSE_TOKEN" });
}

export const _testables = { constantTimeEqualStr, PRINCIPAL_ID_RE };
