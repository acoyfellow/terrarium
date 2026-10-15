import { Sandbox as SdkSandbox, getSandbox } from "@cloudflare/sandbox";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Effect, Layer, Option, Schema } from "effect";

import { Sandbox } from "./run-once.ts";

import { appendCapped, eventsOf, since } from "./activity.ts";
import type { ActivityEvent } from "./activity.ts";
import { detectProof } from "./default-proof.ts";
import { SETUP_ENV, SETUP_TIMEOUT_MS, baseKey, commitSetupCommand, isSetupRequest, sessionFromBaseCommand } from "./warm-base.ts";
import type { BaseInfo } from "./warm-base.ts";
import { ARCHIVE_PATH, MAX_ARCHIVE_BYTES, archiveUrl, clippedDiff, diffCommand, sessionBranch, unpackCommand } from "./repo.ts";
import type { RepoResult, RepoSpec } from "./repo.ts";
import { DEFAULT_STALL, stallMessage, watchStall } from "./stall.ts";
import { ZERO_USAGE, addCall } from "./usage.ts";
import type { CallTokens, Usage } from "./usage.ts";
import { answerModel, isModelRoute, modelError } from "./model-route.ts";
import type { SandboxResult } from "./sandbox-result.ts";
import { Upstream, WorkspaceSnapshot as WorkspaceSnapshotSchema } from "./shared.ts";
import type { ProofResult, RunContract, WorkspaceSnapshot } from "./shared.ts";
import { timingLine } from "./timing.ts";

export type { SandboxResult } from "./sandbox-result.ts";

export { Sandbox } from "./run-once.ts";

export interface ModelEnv {
  readonly AI: Ai;
  readonly TERRARIUM_MODEL_HOST: string;
  readonly TERRARIUM_SANDBOX: DurableObjectNamespace<TerrariumSandbox>;
}

export interface SandboxEnv {
  readonly TERRARIUM_SANDBOX: DurableObjectNamespace<TerrariumSandbox>;
  readonly TERRARIUM_MODEL_HOST: string;
  readonly TERRARIUM_STALL_MS?: string;
  readonly LOOPS_KV: KVNamespace;
}

const STALLED_EXIT = 124;

const stallPolicy = (env: SandboxEnv) => {
  const windowMs = Number(env.TERRARIUM_STALL_MS ?? DEFAULT_STALL.windowMs);

  return Number.isFinite(windowMs) && windowMs >= 30_000 ? { ...DEFAULT_STALL, windowMs } : DEFAULT_STALL;
};

const RUN_TIMEOUT_MS = 600_000;

const PROOF_TIMEOUT_MS = 180_000;

const MAX_PROOF_OUTPUT = 4000;

export const WORKSPACE = "/workspace";

const USAGE_KEY = "terrarium-usage";

const ACTIVE_KEY = "terrarium-last-active";

const SETUP_KEY = "terrarium-setup-open";

const ACTIVITY_KEY = "terrarium-activity";

interface DeployedEnv extends Env {
  readonly TERRARIUM_MODEL_HOST: string;
}

const isDeployed = (env: Env): env is DeployedEnv => "TERRARIUM_MODEL_HOST" in env;

const withModelHost = (env: Env): ModelEnv => {
  const host = isDeployed(env) ? env.TERRARIUM_MODEL_HOST : "";

  return { AI: env.AI, TERRARIUM_MODEL_HOST: host, TERRARIUM_SANDBOX: env.TERRARIUM_SANDBOX };
};

const setupFetch = (box: DurableObjectStub<TerrariumSandbox>, request: Request): Promise<Response> => {
  if (!isSetupRequest(request)) return Promise.resolve(modelError(403, "egress denied"));

  return box.setupOpen().catch(() => false).then((open) => (open ? fetch(request) : modelError(403, "egress denied")));
};

const outbound = (request: Request, generated: Env, ctx: OutboundHandlerContext): Promise<Response> => {
  const env = withModelHost(generated);

  const box = env.TERRARIUM_SANDBOX.get(env.TERRARIUM_SANDBOX.idFromString(ctx.containerId));

  if (!isModelRoute(request, env.TERRARIUM_MODEL_HOST)) return setupFetch(box, request);

  const answer = answerModel(request, env.AI, (tokens) => box.recordTokens(tokens), (reply) => box.recordActivity(eventsOf(reply, Date.now())));

  return box.markActive(Date.now()).then(() => Effect.runPromise(answer), () => Effect.runPromise(answer));
};

export class TerrariumSandbox extends SdkSandbox<ModelEnv> {
  override enableInternet = false;

  override interceptHttps = true;

  async recordTokens(tokens: CallTokens): Promise<void> {
    const total = (await this.ctx.storage.get<Usage>(USAGE_KEY)) ?? ZERO_USAGE;

    await this.ctx.storage.put(USAGE_KEY, addCall(total, tokens));
  }

  async markActive(nowMs: number): Promise<void> {
    await this.ctx.storage.put(ACTIVE_KEY, nowMs);
  }

  async openSetup(): Promise<void> {
    await this.ctx.storage.put(SETUP_KEY, true);
  }

  async closeSetup(): Promise<void> {
    await this.ctx.storage.delete(SETUP_KEY);
  }

  async setupOpen(): Promise<boolean> {
    return (await this.ctx.storage.get<boolean>(SETUP_KEY)) === true;
  }

  async lastActive(): Promise<number | null> {
    return (await this.ctx.storage.get<number>(ACTIVE_KEY)) ?? null;
  }

  async recordActivity(events: ReadonlyArray<ActivityEvent>): Promise<void> {
    if (events.length === 0) return;

    const log = (await this.ctx.storage.get<ReadonlyArray<ActivityEvent>>(ACTIVITY_KEY)) ?? [];

    await this.ctx.storage.put(ACTIVITY_KEY, appendCapped(log, events));
  }

  async readActivity(afterMs: number): Promise<ReadonlyArray<ActivityEvent>> {
    return since((await this.ctx.storage.get<ReadonlyArray<ActivityEvent>>(ACTIVITY_KEY)) ?? [], afterMs);
  }

  async readUsage(): Promise<Usage> {
    return (await this.ctx.storage.get<Usage>(USAGE_KEY)) ?? ZERO_USAGE;
  }
}

TerrariumSandbox.outbound = outbound;

const containerEnv = (modelHost: string) => ({
  TERRARIUM_MODEL: "terrarium/workers-ai",
  TERRARIUM_MODEL_BASE_URL: `https://${modelHost}/_terrarium_model/v1`,
  TERRARIUM_PI_PROVIDER: "/etc/terrarium/terrarium-provider.mjs",
  NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
});

const sandboxCall = <A>(call: () => Promise<A>) => Effect.tryPromise({ try: call, catch: (cause) => new Upstream({ service: "sandbox", detail: String(cause) }) });

const labelStderr = (stderr: string) => stderr.split("\n").filter((line) => line.length > 0).map((line) => `[stderr] ${line}`).join("\n");

export const clipped = (text: string): string => (text.length <= MAX_PROOF_OUTPUT ? text : `...${text.slice(-MAX_PROOF_OUTPUT)}`);

type Box = ReturnType<typeof getSandbox>;

const runProof = (box: Box, command: string, source: "given" | "detected") =>
  sandboxCall(() => box.exec(command, { timeout: PROOF_TIMEOUT_MS, cwd: WORKSPACE })).pipe(
    Effect.map((result): ProofResult => ({ command, exitCode: result.exitCode, output: clipped([result.stdout, result.stderr].filter((part) => part.length > 0).join("\n")), source })),
    Effect.catch((error) => Effect.succeed<ProofResult>({ command, exitCode: null, output: clipped(error.detail), source })),
  );

const readOrEmpty = (box: Box, command: string) =>
  sandboxCall(() => box.exec(command, { timeout: 10_000, cwd: WORKSPACE })).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout : "")),
    Effect.catch(() => Effect.succeed("")),
  );

const workspaceOf = (box: Box) => Effect.all({
  files: readOrEmpty(box, "ls -1A").pipe(Effect.map((text) => text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0))),
  packageJson: readOrEmpty(box, "cat package.json"),
  makefile: readOrEmpty(box, "cat Makefile"),
});

const chooseProof = (box: Box, proof: string | null): Effect.Effect<Option.Option<ProofResult>> => {
  if (proof !== null) return runProof(box, proof, "given").pipe(Effect.map(Option.some));

  return workspaceOf(box).pipe(
    Effect.map(detectProof),
    Effect.flatMap(Option.match({ onNone: () => Effect.succeed(Option.none<ProofResult>()), onSome: (command) => runProof(box, command, "detected").pipe(Effect.map(Option.some)) })),
  );
};

interface Checkout {
  readonly line: string;
  readonly spec: RepoSpec | null;
  readonly baseCommit: string | null;
  readonly base: BaseInfo | null;
}

const NO_CHECKOUT: Checkout = { line: "", spec: null, baseCommit: null, base: null };

const fetchArchive = (url: string) =>
  Effect.tryPromise({ try: () => fetch(url, { redirect: "follow" }), catch: (cause) => new Upstream({ service: "repo", detail: String(cause) }) }).pipe(
    Effect.flatMap((response) => {
      const size = Number(response.headers.get("content-length") ?? 0);

      if (!response.ok) return Effect.fail(new Upstream({ service: "repo", detail: `archive ${response.status}` }));

      if (size > MAX_ARCHIVE_BYTES) return Effect.fail(new Upstream({ service: "repo", detail: `archive is ${size} bytes, over ${MAX_ARCHIVE_BYTES}` }));

      return Effect.tryPromise({ try: () => response.arrayBuffer(), catch: (cause) => new Upstream({ service: "repo", detail: String(cause) }) });
    }),
    Effect.flatMap((bytes) => (bytes.byteLength > MAX_ARCHIVE_BYTES ? Effect.fail(new Upstream({ service: "repo", detail: `archive is ${bytes.byteLength} bytes, over ${MAX_ARCHIVE_BYTES}` })) : Effect.succeed(base64Of(bytes)))),
  );

const base64Of = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  const chunks: Array<string> = [];

  for (let start = 0; start < view.length; start += 0x8000) chunks.push(String.fromCharCode(...view.subarray(start, start + 0x8000)));

  return btoa(chunks.join(""));
};

const checkoutRepo = (box: Box, spec: RepoSpec | null, runId: string): Effect.Effect<Checkout> => {
  if (spec === null) return Effect.succeed(NO_CHECKOUT);

  return Option.match(archiveUrl(spec), {
    onNone: () => Effect.succeed({ ...NO_CHECKOUT, line: `[terrarium:repo] refused ${spec.github}` }),
    onSome: (url) => fetchArchive(url).pipe(
      Effect.flatMap((encoded) => sandboxCall(() => box.writeFile(ARCHIVE_PATH, encoded, { encoding: "base64" }))),
      Effect.flatMap(() => sandboxCall(() => box.exec(unpackCommand(runId), { timeout: 120_000, cwd: "/" }))),
      Effect.flatMap((unpacked) => (unpacked.exitCode === 0 ? Effect.succeed(unpacked.stdout.trim().split("\n").at(-1) ?? "") : Effect.fail(new Upstream({ service: "repo", detail: unpacked.stderr.slice(-400) })))),
      Effect.map((baseCommit): Checkout => ({ spec, baseCommit, base: null, line: `[terrarium:repo] ${spec.github}@${spec.ref ?? "HEAD"} on branch ${sessionBranch(runId)} (base ${baseCommit.slice(0, 12)})` })),
      Effect.catch((error) => Effect.succeed({ ...NO_CHECKOUT, line: `[terrarium:repo] checkout failed: ${error.detail}` })),
    ),
  });
};

const repoOutcome = (box: Box, checkout: Checkout, runId: string): Effect.Effect<RepoResult | null> => {
  const { spec, baseCommit } = checkout;

  if (spec === null || baseCommit === null) return Effect.succeed(null);

  return readOrEmpty(box, diffCommand).pipe(Effect.map((diff) => ({ github: spec.github, ref: spec.ref ?? "HEAD", branch: sessionBranch(runId), baseCommit, ...clippedDiff(diff), base: checkout.base })));
};

const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

interface PrepareJob {
  readonly env: SandboxEnv;
  readonly box: Box;
  readonly stub: DurableObjectStub<TerrariumSandbox>;
  readonly spec: RepoSpec | null;
  readonly runId: string;
  readonly ownerId: string;
}

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

const execOk = (box: Box, command: string, timeout: number, envVars: Record<string, string> = {}) =>
  sandboxCall(() => box.exec(command, { timeout, cwd: WORKSPACE, env: envVars })).pipe(
    Effect.flatMap((result) => (result.exitCode === 0 ? Effect.succeed(result) : Effect.fail(new Upstream({ service: "setup", detail: `exit ${result.exitCode}: ${result.stderr.slice(-400)}` })))),
  );

const BaseSnapshot = Schema.fromJsonString(WorkspaceSnapshotSchema);

const fromBase = (job: PrepareJob, spec: RepoSpec, key: string, snapshot: WorkspaceSnapshot): Effect.Effect<Checkout, Upstream> =>
  sandboxCall(() => job.box.restoreBackup({ id: snapshot.id, dir: snapshot.dir, localBucket: true })).pipe(
    Effect.andThen(execOk(job.box, sessionFromBaseCommand(sessionBranch(job.runId)), 30_000)),
    Effect.map((result): Checkout => ({ spec, baseCommit: lastLine(result.stdout), base: { key, hit: true, setupMs: null, setupExit: null }, line: `[terrarium:repo] ${spec.github}@${spec.ref ?? "HEAD"} from warm base ${key} on branch ${sessionBranch(job.runId)}` })),
  );

const buildBase = (job: PrepareJob, spec: RepoSpec, key: string, setup: string): Effect.Effect<Checkout, Upstream> =>
  Effect.gen(function* () {
    const cold = yield* checkoutRepo(job.box, spec, job.runId);

    if (cold.baseCommit === null) return cold;

    yield* execOk(job.box, "cd /workspace && git checkout -q base", 30_000);
    yield* Effect.tryPromise({ try: () => job.stub.openSetup(), catch: (cause) => new Upstream({ service: "setup", detail: String(cause) }) });
    const setupStart = Date.now();
    const ran = yield* sandboxCall(() => job.box.exec(setup, { timeout: SETUP_TIMEOUT_MS, cwd: WORKSPACE, env: SETUP_ENV })).pipe(Effect.ensuring(Effect.ignore(Effect.tryPromise(() => job.stub.closeSetup()))));
    const setupMs = Date.now() - setupStart;
    const info: BaseInfo = { key, hit: false, setupMs, setupExit: ran.exitCode };

    if (ran.exitCode !== 0) return { ...cold, base: info, line: `${cold.line}\n[terrarium:setup] '${setup}' exited ${ran.exitCode} after ${setupMs} ms; no warm base saved\n${ran.stderr.slice(-600)}` };

    const committed = yield* execOk(job.box, commitSetupCommand, 60_000);
    const backup = yield* sandboxCall(() => job.box.createBackup({ dir: WORKSPACE, name: key, ttl: SNAPSHOT_TTL_SECONDS, localBucket: true }));
    const snapshot: WorkspaceSnapshot = { id: backup.id, dir: backup.dir, localBucket: true, savedAt: new Date().toISOString() };
    yield* Effect.tryPromise({ try: () => job.env.LOOPS_KV.put(key, JSON.stringify(snapshot), { expirationTtl: SNAPSHOT_TTL_SECONDS - 3600 }), catch: (cause) => new Upstream({ service: "kv", detail: String(cause) }) });
    yield* execOk(job.box, `cd /workspace && git checkout -q -B ${sessionBranch(job.runId)}`, 30_000);

    return { spec, baseCommit: lastLine(committed.stdout), base: info, line: `${cold.line}\n[terrarium:setup] '${setup}' took ${setupMs} ms; warm base ${key} saved` };
  });

const prepareRepo = (job: PrepareJob): Effect.Effect<Checkout> => {
  const { spec } = job;

  if (spec === null) return Effect.succeed(NO_CHECKOUT);

  const setup = spec.setup;

  if (setup === undefined) return checkoutRepo(job.box, spec, job.runId);

  return Effect.gen(function* () {
    const key = yield* Effect.promise(() => baseKey(job.ownerId, spec.github, spec.ref ?? "HEAD", setup));
    const stored = yield* Effect.tryPromise(() => job.env.LOOPS_KV.get(key)).pipe(Effect.orElseSucceed(() => null));
    const snapshot = stored === null ? Option.none<WorkspaceSnapshot>() : Schema.decodeUnknownOption(BaseSnapshot)(stored);

    return yield* Option.match(snapshot, {
      onNone: () => buildBase(job, spec, key, setup),
      onSome: (hit) => fromBase(job, spec, key, hit).pipe(Effect.catch(() => buildBase(job, spec, key, setup))),
    });
  }).pipe(Effect.catch((error) => Effect.succeed({ ...NO_CHECKOUT, line: `[terrarium:repo] prepare failed: ${error.detail}` })));
};

const saveWorkspace = (box: Box, runId: string): Effect.Effect<WorkspaceSnapshot | null> =>
  sandboxCall(() => box.createBackup({ dir: WORKSPACE, name: runId, ttl: SNAPSHOT_TTL_SECONDS, localBucket: true, excludes: ["terrarium-task.txt", "terrarium-contract.json"] })).pipe(
    Effect.map((backup): WorkspaceSnapshot => ({ id: backup.id, dir: backup.dir, localBucket: true, savedAt: new Date().toISOString() })),
    Effect.orElseSucceed(() => null),
  );

const restoreInto = (box: Box, snapshot: WorkspaceSnapshot | null): Effect.Effect<string> => {
  if (snapshot === null) return Effect.succeed("");

  return sandboxCall(() => box.restoreBackup({ id: snapshot.id, dir: snapshot.dir, localBucket: true })).pipe(
    Effect.map(() => `[terrarium:resume] restored workspace saved at ${snapshot.savedAt}`),
    Effect.catch((error) => Effect.succeed(`[terrarium:resume] restore failed: ${error.detail}`)),
  );
};

export const sandboxLayer = (env: SandboxEnv) => Layer.succeed(Sandbox, Sandbox.of({
  run: ({ task, contract, proof, resume, repo, ownerId }) => Effect.gen(function* () {
    const box = getSandbox(env.TERRARIUM_SANDBOX, contract.runId);
    const startMs = Date.now();
    const restoreLine = yield* restoreInto(box, resume ?? null);
    const stubForSetup = env.TERRARIUM_SANDBOX.get(env.TERRARIUM_SANDBOX.idFromName(contract.runId));
    const checkout = yield* prepareRepo({ env, box, stub: stubForSetup, spec: repo ?? null, runId: contract.runId, ownerId: ownerId ?? "" });
    yield* sandboxCall(() => box.writeFile(`${WORKSPACE}/terrarium-task.txt`, task));
    const boxReadyMs = Date.now();
    yield* sandboxCall(() => box.writeFile(`${WORKSPACE}/terrarium-contract.json`, JSON.stringify(contract)));
    const stub = env.TERRARIUM_SANDBOX.get(env.TERRARIUM_SANDBOX.idFromName(contract.runId));
    const agent = sandboxCall(() => box.exec("/usr/local/bin/terrarium-runner", { timeout: RUN_TIMEOUT_MS, cwd: WORKSPACE, env: containerEnv(env.TERRARIUM_MODEL_HOST) }));
    const lastActive = Effect.tryPromise(() => stub.lastActive()).pipe(Effect.orElseSucceed(() => null));
    const stall = watchStall(lastActive, Date.now(), stallPolicy(env)).pipe(Effect.map((stalled) => ({ stdout: "", stderr: stallMessage(stalled), exitCode: STALLED_EXIT })));
    const result = yield* Effect.raceFirst(agent, stall);
    const proofResult = result.exitCode === STALLED_EXIT ? null : Option.getOrNull(yield* chooseProof(box, proof));
    const timing = timingLine({ startMs, boxReadyMs, endMs: Date.now(), runnerOutput: result.stdout });
    const usage = yield* Effect.tryPromise(() => stub.readUsage()).pipe(Effect.orElseSucceed(() => ZERO_USAGE));
    const repoResult = yield* repoOutcome(box, checkout, contract.runId);
    const workspace = yield* saveWorkspace(box, contract.runId);

    return { repo: repoResult, output: [restoreLine, checkout.line, result.stdout, labelStderr(result.stderr), timing].filter((part) => part.length > 0).join("\n"), exitCode: result.exitCode, proof: proofResult, usage, workspace };
  }).pipe(Effect.ensuring(Effect.ignore(sandboxCall(() => getSandbox(env.TERRARIUM_SANDBOX, contract.runId).destroy())))),
}));

export const activityOf = (namespace: DurableObjectNamespace<TerrariumSandbox>, runId: string, afterMs: number): Promise<ReadonlyArray<ActivityEvent>> =>
  namespace.get(namespace.idFromName(runId)).readActivity(afterMs);
