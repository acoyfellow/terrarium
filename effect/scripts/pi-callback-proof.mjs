import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const receipt = join(here, "receipts", "pi-callback.json");
const task = "What is 17 multiplied by 23? Reply with just the number.";
const prompt = `Call the terrarium_spawn tool exactly once with background true and task "${task}". Reply only with the runId. When a later message says that run finished, reply with the word CALLBACK then the run summary.`;

const pi = spawn("pi", ["--mode", "rpc", "--no-session", "-e", join(here, "pi-extension", "index.ts"), ...(process.env.PI_PROOF_MODEL ? ["--model", process.env.PI_PROOF_MODEL] : [])], { stdio: ["pipe", "pipe", "inherit"] });

const startedAt = Date.now();
let buffer = "";
let runId = "";
let followUp = "";
let answer = "";

const finish = (ok) => {
  writeFileSync(receipt, `${JSON.stringify({ at: new Date().toISOString(), ok, runId, followUp: followUp.slice(0, 200), answer, seconds: Math.round((Date.now() - startedAt) / 1000) }, null, 2)}\n`);
  console.log(JSON.stringify({ ok, runId, answer }));
  pi.kill();
  process.exit(ok ? 0 : 1);
};

const textOf = (message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));

pi.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type !== "message_end") continue;
    const text = textOf(event.message);
    runId ||= text.match(/ter_[a-z0-9]{6,12}_[a-f0-9]{12}/)?.[0] ?? "";
    if (event.message.role === "user" && text.includes("finished:")) followUp = text;
    if (event.message.role === "assistant" && followUp && text.includes("CALLBACK")) {
      answer = text.trim();
      finish(text.includes("391"));
    }
  }
});

pi.stdin.write(`${JSON.stringify({ id: "proof", type: "prompt", message: prompt })}\n`);
setTimeout(() => finish(false), 300_000);
