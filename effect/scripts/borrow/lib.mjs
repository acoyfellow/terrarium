import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const receiptsDir = join(here, "..", "..", "receipts", "borrow");

export const cloudUrl = () => process.env.TERRARIUM_URL ?? JSON.parse(readFileSync(join(homedir(), ".terrarium", "config.json"), "utf8")).cloudUrl;

export const client = (url = cloudUrl()) => {
  const token = execFileSync("cloudflared", ["access", "token", `-app=${url}`], { encoding: "utf8" }).trim();
  const headers = { "cf-access-token": token, "content-type": "application/json" };

  const call = async (path, init = {}) => {
    const response = await fetch(new URL(path, url), { ...init, headers: { ...headers, ...init.headers } });
    const text = await response.text();
    const json = text.length > 0 && text.startsWith("{") ? JSON.parse(text) : { raw: text };

    return { status: response.status, json };
  };

  const admit = async (body) => {
    const { status, json } = await call("/api/runs", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });

    if (status !== 202) throw new Error(`admit ${status} ${JSON.stringify(json)}`);

    return json.runId;
  };

  const waitFor = async (runId, polls = 200) => {
    for (let poll = 0; poll < polls; poll += 1) {
      const { json } = await call(`/api/runs/${runId}/status`);

      if (json.terminal !== null && json.terminal !== undefined) return json;

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    return null;
  };

  return { url, call, admit, waitFor };
};

export const writeReceipt = (item, receipt) => {
  mkdirSync(receiptsDir, { recursive: true });
  const body = { item, checkedAt: new Date().toISOString(), ...receipt };
  writeFileSync(join(receiptsDir, `${String(item).padStart(2, "0")}.json`), `${JSON.stringify(body, null, 2)}\n`);

  for (const result of receipt.results ?? []) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.note ? ` :: ${result.note}` : ""}`);

  console.log(receipt.ok ? `BORROW ${item} OK` : `BORROW ${item} FAILS`);
  process.exitCode = receipt.ok ? 0 : 1;
};
