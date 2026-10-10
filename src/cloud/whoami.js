import { authenticateAccessUser } from "./access-identity.js";
import { authenticatePrincipal } from "./principal-auth.js";

export async function describeCaller(request, env) {
  const accessUser = await authenticateAccessUser(request, env);
  if (accessUser) return Response.json({ ok: true, method: "access-user", email: accessUser.email, principalId: accessUser.principalId });
  const bearer = authenticatePrincipal(request, env);
  if (bearer.ok) return Response.json({ ok: true, method: "bearer", email: null, principalId: bearer.principalId });
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}
