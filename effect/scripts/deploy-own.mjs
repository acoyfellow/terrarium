import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const usage = `Usage: npm run deploy:own -- --name <name> --host <hostname> --team <team>.cloudflareaccess.com --aud <access-aud>

Before running:
  1. Point a hostname you own at Cloudflare.
  2. In Zero Trust, create a self-hosted Access application for that hostname and copy its AUD tag.

What it does:
  - creates a KV namespace for loops (or reuses one with the same title)
  - writes the gitignored wrangler.<name>.local.jsonc
  - deploys the Worker, container image and Workflows
  - prints the next commands to check it`;

const { values } = parseArgs({ options: { name: { type: "string" }, host: { type: "string" }, team: { type: "string" }, aud: { type: "string" }, "dry-run": { type: "boolean" } } });

const missing = ["name", "host", "team", "aud"].filter((key) => values[key] === undefined || values[key].trim() === "");

if (missing.length > 0) {
  console.error(`missing --${missing.join(", --")}\n\n${usage}`);
  process.exit(2);
}

const name = values.name.trim();
const host = values.host.trim();

if (!/^[a-z0-9-]{1,40}$/.test(name)) {
  console.error("--name must be lowercase letters, digits and dashes");
  process.exit(2);
}

const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const kvTitle = `terrarium-${name}-loops`;

const existingKvId = () => {
  const listed = JSON.parse(wrangler(["kv", "namespace", "list"]));

  return listed.find((namespace) => namespace.title === kvTitle)?.id ?? null;
};

const createKv = () => {
  const output = wrangler(["kv", "namespace", "create", kvTitle]);
  const id = /"?id"?\s*[:=]\s*"([0-9a-f]{32})"/.exec(output)?.[1];

  if (id === undefined) throw new Error(`could not read the KV id from wrangler output:\n${output}`);

  return id;
};

const kvId = values["dry-run"] ? "DRY-RUN-KV-ID" : (existingKvId() ?? createKv());

const base = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
const config = {
  ...base,
  name: `terrarium-${name}`,
  workflows: base.workflows.map((workflow) => ({ ...workflow, name: workflow.name.replace("terrarium-effect", `terrarium-${name}`) })),
  kv_namespaces: [{ binding: "LOOPS_KV", id: kvId }],
  routes: [{ pattern: host, custom_domain: true }],
  vars: { TERRARIUM_ACCESS_TEAM_DOMAIN: values.team.trim(), TERRARIUM_ACCESS_AUD: values.aud.trim(), TERRARIUM_MODEL_HOST: host },
  observability: { enabled: true },
};

const configName = `wrangler.${name}.local.jsonc`;
const configPath = join(root, configName);

if (existsSync(configPath)) console.log(`overwriting ${configName}`);

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${configName} (gitignored)`);

if (values["dry-run"]) {
  console.log("dry run: not deploying");
  process.exit(0);
}

execFileSync("npm", ["run", "build"], { cwd: join(root, ".."), stdio: "inherit" });
execFileSync("npx", ["wrangler", "deploy", "-c", configName], { cwd: root, stdio: "inherit" });

const url = `https://${host}`;

console.log(`
Deployed ${url}

Next:
  terra login ${url}
  TERRARIUM_LOGIN_APP=${url} node scripts/prod-checks.mjs ${url}
  node scripts/egress-check.mjs ${url}
  node scripts/proof-run-check.mjs ${url}`);
