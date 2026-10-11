import { authenticateOwner } from "./web-session.js";

export const EGRESS_PROBE_TARGETS = Object.freeze([
  "https://example.com/",
  "https://api.cloudflare.com/client/v4/user",
  "https://registry.npmjs.org/",
  "https://terrarium.coey.dev/_terrarium_model/v1/models",
]);

const CURL_SECONDS = 8;

export function egressProbeCommand(targets = EGRESS_PROBE_TARGETS) {
  const curls = targets.map((url) => `printf '%s %s\\n' '${url}' "$(curl -s -m ${CURL_SECONDS} -o /dev/null -w '%{http_code}' '${url}' || true)"`);
  return [...curls, "env | cut -d= -f1 | grep -iE 'token|secret|key|auth|pass' | sed 's/^/envname /' || true"].join("; ");
}

export function parseEgressProbeOutput(stdout) {
  const reachable = {};
  const secretEnvNames = [];
  for (const line of String(stdout || "").split("\n")) {
    const [kind, value] = line.trim().split(" ");
    if (kind === "envname" && value) secretEnvNames.push(value);
    else if (kind?.startsWith("https://")) reachable[kind] = value || "000";
  }
  return { reachable, secretEnvNames };
}

export async function handleEgressProbe(request, env, { getSandbox } = {}) {
  const owner = await authenticateOwner(request, env);
  if (!owner.ok) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const resolveSandbox = getSandbox || (await import("@cloudflare/sandbox")).getSandbox;
  const sandboxId = `egress-probe-${crypto.randomUUID()}`;
  const sandbox = resolveSandbox(env.TERRARIUM_SANDBOX, sandboxId);
  try {
    const result = await sandbox.exec(egressProbeCommand());
    return Response.json({ ok: true, sandboxId, exitCode: result.exitCode, ...parseEgressProbeOutput(result.stdout) });
  } finally {
    await sandbox.destroy?.().catch(() => {});
  }
}
