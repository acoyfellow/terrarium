#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { cpus, freemem, loadavg, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "./tasks.mjs";
import { gradeReply, promptFor } from "./grade.mjs";
import { cloudSpawn, cloudRead, detectFilesystemDependency } from "../../src/cloud-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_PREAMBLE = "You are a Terrarium bounded worker. Complete exactly the task below in a single reply. Do not ask questions. Do not use tools.";
const AGENT_TIMEOUT_MS = 180_000;
const SAMPLE_MS = 1000;

function parseArgs(argv) {
  const options = { lane: "", concurrency: 1, repeat: 1, limit: 0, out: join(here, "results") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--lane") options.lane = argv[++i];
    else if (flag === "--concurrency") options.concurrency = Number(argv[++i]);
    else if (flag === "--repeat") options.repeat = Number(argv[++i]);
    else if (flag === "--out") options.out = argv[++i];
    else if (flag === "--limit") options.limit = Number(argv[++i]);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!["laptop", "cloud"].includes(options.lane)) throw new Error("--lane laptop|cloud is required");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  return options;
}

function buildJobs(repeat) {
  const jobs = [];
  for (let round = 0; round < repeat; round++) {
    for (const task of TASKS) jobs.push({ key: `${task.id}#${round}`, task, prompt: promptFor(task) });
  }
  return jobs;
}

function laptopCredentials() {
  const accountId = process.env.PARALLEL_BENCH_ACCOUNT_ID;
  if (!accountId) throw new Error("PARALLEL_BENCH_ACCOUNT_ID is required for the laptop lane");
  const raw = execFileSync("npx", ["wrangler", "auth", "token", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const token = JSON.parse(raw).token;
  if (!token) throw new Error("wrangler did not return a token");
  return { accountId, token };
}

function runLaptopJob(job, credentials) {
  const workdir = mkdtempSync(join(tmpdir(), "parallel-bench-"));
  const promptFile = join(workdir, "prompt.txt");
  const nonce = crypto.randomUUID();
  const receiptInstruction = `Your final line MUST be exactly one JSON receipt, nothing after it:\nTERRARIUM_RESULT={"nonce":"${nonce}","summary":"<short result>"}`;
  writeFileSync(promptFile, `${WORKER_PREAMBLE}\n\nTask:\n${job.prompt}\n\n${receiptInstruction}\n`);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("pi", [
      "-p", "--no-session", "-ne", "-ns", "-np", "-nc", "--no-tools",
      "-e", join(here, "workers-ai-provider.mjs"),
      "--provider", "bench-workers-ai", "--model", "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      `@${promptFile}`,
    ], {
      cwd: workdir,
      env: { ...process.env, HOME: workdir, PARALLEL_BENCH_ACCOUNT_ID: credentials.accountId, PARALLEL_BENCH_AI_TOKEN: credentials.token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), AGENT_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(workdir, { recursive: true, force: true });
      resolve({ reply: output, ms: Date.now() - started, exitCode: code, runId: null, verified: null });
    });
  });
}

async function runCloudJob(job) {
  const started = Date.now();
  const result = await cloudSpawn({ task: job.prompt, channel: "parallel-offload-bench", timeoutMs: AGENT_TIMEOUT_MS }, { pollMs: 2000, maxPolls: 200 });
  const logs = result.runId ? await cloudRead(result.runId).catch(() => ({ text: "" })) : { text: "" };
  return {
    reply: logs.text || result.taskResultSummary || "",
    ms: Date.now() - started,
    exitCode: result.exitCode ?? null,
    runId: result.runId ?? null,
    status: result.status,
    verified: result.taskContractStatus === "verified",
    error: result.error ?? null,
  };
}

function startLaptopSampler() {
  const samples = [];
  const cores = cpus().length;
  const timer = setInterval(() => {
    let piCpu = 0;
    let piRssMb = 0;
    let piProcesses = 0;
    try {
      const table = execFileSync("ps", ["-axo", "pcpu=,rss=,command="], { encoding: "utf8" });
      for (const line of table.split("\n")) {
        const match = line.trim().match(/^([\d.]+)\s+(\d+)\s+(.*)$/);
        if (!match || !match[3].includes("bench-workers-ai")) continue;
        piProcesses += 1;
        piCpu += Number(match[1]);
        piRssMb += Number(match[2]) / 1024;
      }
    } catch {}
    samples.push({
      t: Date.now(),
      load1: loadavg()[0],
      usedMemMb: Math.round((totalmem() - freemem()) / 1048576),
      benchProcesses: piProcesses,
      benchCpuPercentOfMachine: Math.round(piCpu / cores),
      benchRssMb: Math.round(piRssMb),
    });
  }, SAMPLE_MS);
  return { stop: () => { clearInterval(timer); return samples; } };
}

async function runPool(jobs, concurrency, worker) {
  const results = new Array(jobs.length);
  let next = 0;
  async function lane() {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await worker(jobs[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, lane));
  return results;
}

function summarize(samples, key) {
  if (!samples.length) return null;
  const values = samples.map((s) => s[key]);
  return { max: Math.max(...values), mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allJobs = buildJobs(options.repeat);
  const jobs = options.limit > 0 ? allJobs.slice(0, options.limit) : allJobs;
  if (options.lane === "cloud") {
    const flagged = jobs.filter((job) => detectFilesystemDependency({ task: job.prompt }).dependent);
    if (flagged.length) throw new Error(`cloud preflight would refuse ${flagged.map((j) => j.key).join(", ")}`);
  }
  const credentials = options.lane === "laptop" ? laptopCredentials() : null;
  const worker = options.lane === "laptop" ? (job) => runLaptopJob(job, credentials) : runCloudJob;

  const sampler = startLaptopSampler();
  const started = Date.now();
  const outcomes = await runPool(jobs, options.concurrency, async (job) => {
    const outcome = await worker(job);
    const grade = gradeReply(job.task, outcome.reply);
    process.stderr.write(`${grade.pass ? "pass" : "FAIL"} ${job.key} ${outcome.ms}ms ${outcome.runId ?? ""}\n`);
    return { key: job.key, taskId: job.task.id, ...outcome, pass: grade.pass, gradeReason: grade.reason, reply: outcome.reply.slice(-4000) };
  });
  const wallMs = Date.now() - started;
  const samples = sampler.stop();

  const passed = outcomes.filter((o) => o.pass).length;
  const summary = {
    lane: options.lane,
    concurrency: options.concurrency,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    jobs: jobs.length,
    passed,
    accuracy: Number((passed / jobs.length).toFixed(3)),
    wallSeconds: Number((wallMs / 1000).toFixed(1)),
    perJobSeconds: {
      median: Number((outcomes.map((o) => o.ms).sort((a, b) => a - b)[Math.floor(outcomes.length / 2)] / 1000).toFixed(1)),
      max: Number((Math.max(...outcomes.map((o) => o.ms)) / 1000).toFixed(1)),
    },
    verifiedReceipts: options.lane === "cloud" ? outcomes.filter((o) => o.verified).length : null,
    laptop: {
      cores: cpus().length,
      benchProcesses: summarize(samples, "benchProcesses"),
      benchCpuPercentOfMachine: summarize(samples, "benchCpuPercentOfMachine"),
      benchRssMb: summarize(samples, "benchRssMb"),
      load1: summarize(samples, "load1"),
    },
    startedAt: new Date(started).toISOString(),
  };

  mkdirSync(options.out, { recursive: true });
  const stamp = new Date(started).toISOString().replaceAll(":", "-").replace(/\..+/, "");
  const file = join(options.out, `${stamp}-${options.lane}-c${options.concurrency}.json`);
  writeFileSync(file, `${JSON.stringify({ summary, outcomes, samples }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`saved ${file}`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
