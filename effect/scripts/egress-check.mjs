import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const receipt = join(here, "..", "receipts", "egress.json");
const configured = () => JSON.parse(readFileSync(join(homedir(), ".terrarium", "config.json"), "utf8")).cloudUrl;
const url = process.env.TERRARIUM_EFFECT_URL ?? configured();
const outside = ["https://example.com/", "https://api.cloudflare.com/client/v4/user", "https://registry.npmjs.org/"];

const token = execFileSync("cloudflared", ["access", "token", `-app=${url}`], { encoding: "utf8" }).trim();
const response = await fetch(new URL("/api/egress-probe", url), { headers: { "cf-access-token": token } });
const report = await response.json();

const reached = (code) => code !== "000" && code !== "520" && code !== "403";
const modelEntry = Object.entries(report.reachable ?? {}).find(([target]) => target.includes("/_terrarium_model/"));
const checks = [
  { name: "probe answered", pass: response.status === 200 && report.ok === true },
  ...outside.map((target) => ({ name: `blocked ${target}`, pass: !reached(report.reachable?.[target] ?? "000"), code: report.reachable?.[target] })),
  { name: "model host answers through the Worker", pass: modelEntry?.[1] === "200", code: modelEntry?.[1] },
  { name: "no secret-looking env names", pass: Array.isArray(report.secretEnvNames) && report.secretEnvNames.length === 0 },
];
const ok = checks.every((check) => check.pass);
const hostless = Object.fromEntries(Object.entries(report.reachable ?? {}).map(([target, code]) => [target.includes("/_terrarium_model/") ? "model-host" : target, code]));

mkdirSync(dirname(receipt), { recursive: true });
writeFileSync(receipt, `${JSON.stringify({ at: new Date().toISOString(), ok, checks, reachable: hostless, piStartupMs: report.piStartupMs, totalMs: report.totalMs }, null, 2)}\n`);
for (const check of checks) console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}${check.code ? ` (${check.code})` : ""}`);
console.log(ok ? "EGRESS CHECK PASSES" : "EGRESS CHECK FAILS");
process.exit(ok ? 0 : 1);
