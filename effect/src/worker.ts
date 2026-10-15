import { getSandbox } from "@cloudflare/sandbox";

import { handleRequest } from "./app.ts";
import type { AppEnv } from "./app.ts";
import { activityOf } from "./sandbox.ts";
import type { SandboxEnv } from "./sandbox.ts";

export { OwnerDO } from "./owner-do.ts";

export { RunWorkflow } from "./run-workflow.ts";

export { LoopWorkflow } from "./loop-workflow.ts";

export { TerrariumSandbox } from "./sandbox.ts";

export { ContainerProxy } from "@cloudflare/sandbox";

type WorkerEnv = AppEnv & SandboxEnv;

const probeBoxes = (env: WorkerEnv) => ({ modelHost: env.TERRARIUM_MODEL_HOST, fresh: () => getSandbox(env.TERRARIUM_SANDBOX, `egress-probe-${crypto.randomUUID()}`), activity: (runId: string, afterMs: number) => activityOf(env.TERRARIUM_SANDBOX, runId, afterMs) });

export default { fetch: (request: Request, env: WorkerEnv) => handleRequest(request, env, probeBoxes(env)) };
