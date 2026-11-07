import { getSandbox } from "@cloudflare/sandbox";

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import { accessIdentity, handleAsOwner, handleRequest } from "./app.ts";
import { lazyOAuthWorker } from "./oauth.ts";
import type { AppEnv } from "./app.ts";
import { activityOf } from "./sandbox.ts";
import type { SessionDO } from "./session-do.ts";
import type { SandboxEnv } from "./sandbox.ts";

export { OwnerDO } from "./owner-do.ts";

export { RunWorkflow } from "./run-workflow.ts";

export { LoopWorkflow } from "./loop-workflow.ts";

export { TerrariumSandbox } from "./sandbox.ts";

export { SessionDO } from "./session-do.ts";

export { ContainerProxy } from "@cloudflare/sandbox";

type WorkerEnv = AppEnv & SandboxEnv & { readonly SESSION: DurableObjectNamespace<SessionDO> };

const probeBoxes = (env: WorkerEnv) => ({ modelHost: env.TERRARIUM_MODEL_HOST, fresh: () => getSandbox(env.TERRARIUM_SANDBOX, `egress-probe-${crypto.randomUUID()}`), activity: (runId: string, afterMs: number) => activityOf(env.TERRARIUM_SANDBOX, runId, afterMs), session: (key: string) => env.SESSION.get(env.SESSION.idFromName(key)) });

type OAuthWorkerEnv = WorkerEnv & { readonly OAUTH_PROVIDER: OAuthHelpers; readonly OAUTH_KV: KVNamespace; readonly TERRARIUM_PUBLIC_ORIGIN?: string };

export default lazyOAuthWorker<OAuthWorkerEnv>({
  accessIdentity: (request, env) => accessIdentity(request, env),
  asOwner: (request, env, identity) => handleAsOwner(request, env, probeBoxes(env), identity),
  fallback: (request, env) => handleRequest(request, env, probeBoxes(env)),
});
