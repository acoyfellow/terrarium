import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const receiptsDir = join(here, "..", "receipts", "borrow");
const checksDir = join(here, "borrow");
const items = Array.from({ length: 18 }, (_, index) => index + 1);
const rerun = process.argv.includes("--rerun");
const maxAgeMs = 7 * 24 * 60 * 60 * 1000;

const scriptFor = (item) => readdirSync(checksDir).find((name) => name.startsWith(`${String(item).padStart(2, "0")}-`));

const receiptFor = (item) => {
  const path = join(receiptsDir, `${String(item).padStart(2, "0")}.json`);

  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};

const rows = items.map((item) => {
  const script = scriptFor(item);

  if (rerun && script !== undefined) {
    const status = (() => {
      try {
        execFileSync("node", [join(checksDir, script)], { stdio: "inherit" });

        return 0;
      } catch (error) {
        return error.status ?? 1;
      }
    })();

    if (status !== 0) return { item, ok: false, why: `live check exited ${status}` };
  }

  const receipt = receiptFor(item);

  if (receipt === null) return { item, ok: false, why: script === undefined ? "no check script, no receipt" : "no receipt" };

  if (Date.now() - Date.parse(receipt.checkedAt) > maxAgeMs) return { item, ok: false, why: `receipt older than 7 days (${receipt.checkedAt})` };

  return { item, ok: receipt.ok === true, why: receipt.ok === true ? receipt.title : "receipt ok is false" };
});

const defendPath = join(here, "..", "receipts", "defend.json");
const defend = existsSync(defendPath) ? JSON.parse(readFileSync(defendPath, "utf8")) : null;
const defendOk = defend !== null && ["terrarium", "daytona", "piSubagents"].every((arm) => defend.arms?.[arm]?.found !== undefined);

for (const row of rows) console.log(`${row.ok ? "PASS" : "FAIL"} borrow ${String(row.item).padStart(2, "0")}: ${row.why}`);

console.log(`${defendOk ? "PASS" : "FAIL"} defend.json: ${defend === null ? "missing" : defendOk ? "three arms scored" : "an arm is unscored"}`);

const passed = rows.filter((row) => row.ok).length;

console.log(`${passed}/18 borrowed, defend ${defendOk ? "recorded" : "missing"}`);

process.exit(passed === 18 && defendOk ? 0 : 1);
