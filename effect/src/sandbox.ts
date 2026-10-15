import { Sandbox as SdkSandbox, getSandbox } from "@cloudflare/sandbox";
import type { OutboundHandlerContext } from "@cloudflare/containers";
import { Effect, Layer, Option } from "effect";

import { Sandbox } from "./run-once.ts";

import { detectProof } from "./default-proof.ts";
import { DEFAULT_STALL, stallMessage, watchStall } from "./stall.ts";
import { ZERO_USAGE, addCall } from "./usage.ts";
import type { CallTokens, Usage } from "./usage.ts";
import { answerModel, isModelRoute, modelError } from "./model-route.ts";
import type { SandboxResult } from "./sandbox-result.ts";
import { Upstream } from "./shared.ts";
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

interface DeployedEnv extends Env {
  readonly TERRARIUM_MODEL_HOST: string;
}

const isDeployed = (env: Env): env is DeployedEnv => "TERRARIUM_MODEL_HOST" in env;

const withModelHost = (env: Env): ModelEnv => {
  const host = isDeployed(env) ? env.TERRARIUM_MODEL_HOST : "";

  return { AI: env.AI, TERRARIUM_MODEL_HOST: host, TERRARIUM_SANDBOX: env.TERRARIUM_SANDBOX };
};

const outbound = (request: Request, generated: Env, ctx: OutboundHandlerContext): Promise<Response> => {
  const env = withModelHost(generated);

  if (!isModelRoute(request, env.TERRARIUM_MODEL_HOST)) return Promise.resolve(modelError(403, "egress denied"));

  const box = env.TERRARIUM_SANDBOX.get(env.TERRARIUM_SANDBOX.idFromString(ctx.containerId));

  const answer = answerModel(request, env.AI, (tokens) => box.recordTokens(tokens));

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

  async lastActive(): Promise<number | null> {
    return (await this.ctx.storage.get<number>(ACTIVE_KEY)) ?? null;
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

const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;

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
  run: ({ task, contract, proof, resume }) => Effect.gen(function* () {
    const box = getSandbox(env.TERRARIUM_SANDBOX, contract.runId);
    const startMs = Date.now();
    const restoreLine = yield* restoreInto(box, resume ?? null);
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
    const workspace = yield* saveWorkspace(box, contract.runId);

    return { output: [restoreLine, result.stdout, labelStderr(result.stderr), timing].filter((part) => part.length > 0).join("\n"), exitCode: result.exitCode, proof: proofResult, usage, workspace };
  }).pipe(Effect.ensuring(Effect.ignore(sandboxCall(() => getSandbox(env.TERRARIUM_SANDBOX, contract.runId).destroy())))),
}));
