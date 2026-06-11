function timingSafeEqualText(a, b) {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let mismatch = 0;
  for (let i = 0; i < aa.length; i++) mismatch |= aa[i] ^ bb[i];
  return mismatch === 0;
}

export function isAuthorized(request, token) {
  if (!token) return false;
  return timingSafeEqualText(request.headers.get("authorization") || "", `Bearer ${token}`);
}

export function requireAuthorization(request, env) {
  return isAuthorized(request, env.TERRARIUM_CONTROL_TOKEN)
    ? null
    : Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}
