import { createHash } from "node:crypto";

export const PROTECTED_FIX_PATHS = [
  /^\.github\/workflows\//,
  /^src\/(?:sandbox|hostile|lab|controller-auth|public-ledger|fix-policy)\.js$/,
  /^test\/(?:sandbox|hostile|lab|controller-auth|public-ledger|fix-policy)\.test\.js$/,
  /^(?:THREAT_MODEL|COMPATIBILITY)\.md$/,
  /^wrangler\.(?:jsonc|toml)$/,
];

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /(?:authorization|api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i,
];

export function changedPathsFromPatch(patch) {
  if (typeof patch !== "string") throw new Error("fix patch must be text");
  const paths = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (match) paths.push(match[2]);
  }
  return [...new Set(paths)];
}

export function patchDigest(patch) {
  return createHash("sha256").update(patch).digest("hex");
}

export function validateFixPatch({ patch, baseRevision, expectedBaseRevision, requiredTestPrefix = "test/", allowProtected = [] } = {}) {
  if (!/^[a-f0-9]{40}$/i.test(baseRevision || "") || baseRevision !== expectedBaseRevision) throw new Error("fix patch base revision does not match frozen finding revision");
  const paths = changedPathsFromPatch(patch);
  if (!paths.length) throw new Error("fix patch contains no changed files");
  const allowed = new Set(allowProtected);
  const protectedPath = paths.find((path) => !allowed.has(path) && PROTECTED_FIX_PATHS.some((pattern) => pattern.test(path)));
  if (protectedPath) throw new Error(`fix patch modifies protected path: ${protectedPath}`);
  if (!paths.some((path) => path.startsWith(requiredTestPrefix) && /\.test\.js$/.test(path))) throw new Error("fix patch must add or modify a regression test");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(patch))) throw new Error("fix patch contains a credential-like secret");
  return { ok: true, paths, patchDigest: patchDigest(patch), baseRevision };
}

export function assertReplayBinding({ findingPayloadHash, replayPayloadHash, findingScenarioId, replayScenarioId, findingRevision, patchBaseRevision } = {}) {
  if (!findingPayloadHash || findingPayloadHash !== replayPayloadHash) throw new Error("replay payload does not match frozen finding payload");
  if (!findingScenarioId || findingScenarioId !== replayScenarioId) throw new Error("replay detector does not match finding detector");
  if (!findingRevision || findingRevision !== patchBaseRevision) throw new Error("fix branch is not based on the affected revision");
  return true;
}
