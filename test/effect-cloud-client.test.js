import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertEffectCloudForegroundCapability,
  effectCloudAdmitBackground,
  effectCloudSpawn,
  effectCloudSpawnBatch,
} from "../src/effect-cloud-client.js";

const env = {
  TERRARIUM_HOME: process.env.TERRARIUM_HOME,
  TERRARIUM_URL: "https://effect.example.test",
  TERRARIUM_CONTROL_TOKEN: "effect-token",
};

const contract = (runId) => ({
  runId,
  taskFingerprint: "fingerprint-1",
  nonce: "nonce-1",
});

const terminal = (runId, extra = {}) => ({
  ...contract(runId),
  summary: "completed",
  ok: true,
  ...extra,
});

function response(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

const MCP_PATH = fileURLToPath(new URL("../src/mcp.js", import.meta.url));

function mcpSpawn(env, args = { task: "reply with OK" }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP_PATH], { stdio: ["pipe", "pipe", "pipe"], env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("close", () => {
      const line = output.split("\n").filter(Boolean).map((value) => JSON.parse(value)).find((value) => value.id === 1);
      resolve(JSON.parse(line.result.content[0].text));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "terrarium_spawn", arguments: args } })}\n`);
    child.stdin.end();
  });
}

test("Effect CloudClient capability is direct and fail closed", () => {
  assert.doesNotThrow(() => assertEffectCloudForegroundCapability({ task: "reply with OK" }, { env }));
  assert.doesNotThrow(() => assertEffectCloudForegroundCapability({ task: "reply with OK", background: true }, { env }));
  assert.throws(
    () => assertEffectCloudForegroundCapability({ task: "reply with OK", agent: "pi -p" }, { env }),
    /does not support cloud option: agent/,
  );
  assert.throws(
    () => assertEffectCloudForegroundCapability({ task: "review /Users/person/repo" }, { env }),
    /cloud spawn refused/,
  );
});

test("Effect CloudClient rejects dry-run plans before admission", async () => {
  let requests = 0;
  await assert.rejects(
    () => effectCloudSpawn({ task: "reply with OK", dryRun: true }, {
      env,
      fetchImpl: async () => {
        requests += 1;
        return response(202, {});
      },
    }),
    /does not execute dry-run plans/,
  );
  assert.equal(requests, 0);
});

test("Effect CloudClient preserves bearer auth, one idempotency key, and correlated receipt authority", async () => {
  const runId = "ter_effect01_deadbeef";
  const requests = [];
  const scripted = [
    response(503, { error: "overloaded" }),
    response(202, { runId, contract: contract(runId), executionRef: "exec-1" }),
    response(200, { status: { status: "done", terminal: terminal(runId) } }),
  ];
  const result = await effectCloudSpawn(
    { task: "reply with OK", timeoutMs: 250, model: "test-model", channel: "channel-1", workflowId: "workflow-1" },
    {
      env,
      idempotencyKey: "idem-effect-1",
      pollMs: 0,
      maxPolls: 1,
      retryDelayMs: 0,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return scripted.shift();
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.runId, runId);
  assert.equal(result.effectCloud, true);
  assert.deepEqual(result.correlation, { idempotencyKey: "idem-effect-1", runId });
  assert.equal(requests.length, 3);
  assert.equal(requests[0].init.headers.authorization, "Bearer effect-token");
  assert.equal(requests[0].init.headers["idempotency-key"], "idem-effect-1");
  assert.equal(requests[1].init.headers["idempotency-key"], "idem-effect-1");
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    task: "reply with OK",
    spec: { deadlineMs: 250, model: "test-model", channel: "channel-1", workflowId: "workflow-1" },
  });
  assert.equal(new URL(requests[2].url).pathname, `/api/runs/${runId}/status`);
});

test("a definite pre-admission rejection stays rejected without creating a run", async () => {
  const requests = [];
  const result = await effectCloudSpawn(
    { task: "reply with OK" },
    {
      env,
      idempotencyKey: "idem-rejected",
      fetchImpl: async (_url, init) => {
        requests.push(init);
        return response(400, { error: "task rejected" });
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.runId, undefined);
  assert.deepEqual(result.correlation, { idempotencyKey: "idem-rejected", runId: null });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers["idempotency-key"], "idem-rejected");
});

test("an ambiguous background Effect admission returns its idempotency correlation without fallback", async () => {
  const attempts = [];
  const result = await effectCloudAdmitBackground(
    { task: "reply with OK", background: true },
    {
      env,
      idempotencyKey: "idem-ambiguous",
      retryDelayMs: 0,
      fetchImpl: async (_url, init) => {
        attempts.push(init);
        throw new Error("connection reset");
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "ambiguous-admission");
  assert.equal(result.background, undefined);
  assert.deepEqual(result.correlation, { idempotencyKey: "idem-ambiguous", runId: null });
  assert.match(result.error, /Reconcile with idempotency key idem-ambiguous/);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].headers["idempotency-key"], "idem-ambiguous");
});

test("a malformed terminal receipt returns an ambiguous Effect result with the admitted run correlation", async () => {
  const runId = "ter_effect02_feedface";
  const requests = [];
  const scripted = [
    response(202, { runId, contract: contract(runId) }),
    response(200, { status: { status: "done", terminal: { ...terminal(runId), nonce: "wrong-nonce" } } }),
  ];
  const result = await effectCloudSpawn(
    { task: "reply with OK" },
    {
      env,
      idempotencyKey: "idem-receipt",
      pollMs: 0,
      maxPolls: 1,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return scripted.shift();
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "ambiguous-effect-result");
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.correlation, { idempotencyKey: "idem-receipt", runId });
  assert.match(result.error, /Reconcile with idempotency key idem-receipt/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[1].init.method, "GET");
  assert.equal(requests.filter(({ init }) => init.method === "POST").length, 1);
});

test("Effect CloudClient background admission returns a correlated durable running result without polling", async () => {
  const runId = "ter_effect04_deadbeef";
  const requests = [];
  const admissions = [];
  const result = await effectCloudAdmitBackground(
    { task: "reply with OK", background: true, channel: "background-channel", workflowId: "background-workflow" },
    {
      env,
      idempotencyKey: "idem-background",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return response(202, { runId, contract: contract(runId), executionRef: "exec-background" });
      },
      recordAdmission: async (admission) => { admissions.push(admission); },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    runId,
    status: "running",
    background: true,
    cloud: true,
    effectCloud: true,
    contract: contract(runId),
    executionRef: "exec-background",
    idempotencyKey: "idem-background",
    correlation: { idempotencyKey: "idem-background", runId },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.authorization, "Bearer effect-token");
  assert.equal(requests[0].init.headers["idempotency-key"], "idem-background");
  assert.deepEqual(admissions, [{
    runId,
    channel: "background-channel",
    workflowId: "background-workflow",
    task: "reply with OK",
    model: null,
    contract: contract(runId),
    executionRef: "exec-background",
    background: true,
  }]);
});

test("Effect CloudBatch maps MCP jobs, persists admissions, and returns a concise-compatible result", async () => {
  const requests = [];
  const persisted = [];
  const runIds = { first: "ter_batch_first", second: "ter_batch_second" };
  const result = await effectCloudSpawnBatch(
    {
      jobs: [
        { task: "first", model: "batch-model", channel: "batch-channel", workflowId: "batch-workflow" },
        { task: "second" },
      ],
      strategy: "all",
      concurrency: 2,
      pollMs: 0,
    },
    {
      env,
      idempotencyKey: "idem-batch",
      recordAdmission: async (admission) => { persisted.push(admission); },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        const path = new URL(url).pathname;
        if (init.method === "POST") {
          const { task } = JSON.parse(init.body);
          const runId = runIds[task];
          return response(202, { runId, contract: contract(runId), executionRef: `execution-${task}` });
        }
        const runId = path.split("/")[3];
        return response(200, { status: { status: "done", terminal: terminal(runId) } });
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.effectCloud, true);
  assert.deepEqual(result.runIds.sort(), Object.values(runIds).sort());
  assert.equal(result.group.complete, true);
  assert.deepEqual(result.group.runs.map((run) => run.status).sort(), ["done", "done"]);
  assert.deepEqual(requests.filter(({ init }) => init.method === "POST").map(({ init }) => init.headers["idempotency-key"]).sort(), ["idem-batch.0", "idem-batch.1"]);
  assert.ok(requests.every(({ init }) => init.headers.authorization === "Bearer effect-token"));
  assert.deepEqual(persisted.map((admission) => admission.runId).sort(), Object.values(runIds).sort());
  assert.equal(persisted.find((admission) => admission.runId === runIds.first).channel, "batch-channel");
});

test("MCP routes background cloud spawns to Effect admission without polling", async () => {
  const runId = "ter_effect04_deadbeef";
  const requests = [];
  const server = createServer((request, responseStream) => {
    requests.push(request);
    responseStream.writeHead(202, { "content-type": "application/json" });
    responseStream.end(JSON.stringify({ runId, contract: contract(runId) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const backgroundEnv = {
    ...process.env,
    TERRARIUM_URL: `http://127.0.0.1:${address.port}`,
    TERRARIUM_CONTROL_TOKEN: "mcp-background-token",
    TERRARIUM_ALLOW_LOCAL: "",
    TERRARIUM_RUN_ID: "",
    TERRARIUM_ALLOW_SPAWN: "",
  };
  try {
    const result = await mcpSpawn(backgroundEnv, { task: "reply with OK", background: true });
    assert.equal(result.ok, true);
    assert.equal(result.status, "running");
    assert.equal(result.background, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("MCP sends foreground cloud spawns to Effect without a feature flag", async () => {
  const runId = "ter_effect03_cafebabe";
  const requests = [];
  const server = createServer((request, responseStream) => {
    requests.push(request);
    const body = request.method === "POST"
      ? { runId, contract: contract(runId) }
      : { status: { status: "done", terminal: { ok: true } } };
    responseStream.writeHead(request.method === "POST" ? 202 : 200, { "content-type": "application/json" });
    responseStream.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseEnv = {
    ...process.env,
    TERRARIUM_URL: `http://127.0.0.1:${address.port}`,
    TERRARIUM_CONTROL_TOKEN: "mcp-effect-token",
    TERRARIUM_ALLOW_LOCAL: "",
    TERRARIUM_RUN_ID: "",
    TERRARIUM_ALLOW_SPAWN: "",
  };
  try {
    const result = await mcpSpawn(baseEnv);
    assert.equal(result.status, "ambiguous-effect-result");
    assert.ok(result.correlation?.idempotencyKey);
    assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Effect cloud batch uses API-legal per-job idempotency keys", async () => {
  const keys = [];
  const runIds = ["ter_batch_a", "ter_batch_b", "ter_batch_c"];
  const result = await effectCloudSpawnBatch(
    {
      jobs: [{ task: "A" }, { task: "B" }, { task: "C" }],
      strategy: "all",
      concurrency: 3,
      pollMs: 0,
    },
    {
      env,
      idempotencyKey: "7f3c9a2b-1d4e-4f60-8a1b-2c3d4e5f6a7b",
      fetchImpl: async (url, init) => {
        if (init.method === "POST") {
          keys.push(init.headers["idempotency-key"]);
          const { task } = JSON.parse(init.body);
          const runId = runIds["ABC".indexOf(task)];
          return response(202, { runId, contract: contract(runId), executionRef: `exec-${task}` });
        }
        const runId = new URL(url).pathname.split("/")[3];
        return response(200, { status: { status: "done", terminal: terminal(runId) } });
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(keys.sort(), [
    "7f3c9a2b-1d4e-4f60-8a1b-2c3d4e5f6a7b.0",
    "7f3c9a2b-1d4e-4f60-8a1b-2c3d4e5f6a7b.1",
    "7f3c9a2b-1d4e-4f60-8a1b-2c3d4e5f6a7b.2",
  ]);
  assert.equal(keys.every((key) => /^[A-Za-z0-9._~+/=-]{8,255}$/.test(key)), true);
  assert.equal(keys.some((key) => key.includes(":")), false);
  assert.equal(result.runIds.length, 3);
});

test("Effect cloud batch surfaces per-job admission 400s instead of empty all-complete", async () => {
  const result = await effectCloudSpawnBatch(
    {
      jobs: [{ task: "A" }, { task: "B" }, { task: "C" }],
      strategy: "all",
      concurrency: 3,
      pollMs: 0,
    },
    {
      env,
      idempotencyKey: "idem-batch-400",
      fetchImpl: async (_url, init) => {
        if (init.method === "POST") {
          return response(400, { ok: false, error: "idempotency-key required" });
        }
        return response(404, { ok: false });
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "admission-failed");
  assert.equal(result.error, "cloud batch settled without admitting any runs");
  assert.deepEqual(result.runIds, []);
  assert.deepEqual(result.admissions, []);
  assert.equal(result.jobErrors.length, 3);
  assert.deepEqual(result.jobErrors.map((job) => job.index).sort(), [0, 1, 2]);
});
