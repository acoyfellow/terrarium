import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { ACCESS_TOKEN_TTL_SECONDS, AUTHORIZE_PATH, authorizeHandler, identityFromProps, MCP_PATH, MCP_SCOPE, REGISTER_PATH, TOKEN_PATH } from "./oauth-authorize.ts";
import type { OAuthDeps, OAuthEnv } from "./oauth-authorize.ts";
import { handleMcp } from "./remote-mcp.ts";

export function createOAuthWorker<Env extends OAuthEnv>(deps: OAuthDeps<Env>, publicOrigin: string) {
  const authorize = authorizeHandler(deps);

  return new OAuthProvider<Env>({
    resourceMetadata: { resource: new URL(publicOrigin).origin, resource_name: "Terrarium" },
    apiRoute: MCP_PATH,
    apiHandler: {
      fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
        const identity = identityFromProps(ctx.props);

        if (!identity) return new Response("invalid grant", { status: 401 });

        return handleMcp(request, identity, (inner) => deps.asOwner(inner, env, identity));
      },
    },
    defaultHandler: {
      fetch: (request: Request, env: Env, ctx: ExecutionContext) => {
        const { pathname } = new URL(request.url);

        if (pathname === AUTHORIZE_PATH) return authorize(request, env);

        return deps.fallback(request, env, ctx);
      },
    },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    scopesSupported: [MCP_SCOPE],
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function lazyOAuthWorker<Env extends OAuthEnv & { readonly TERRARIUM_PUBLIC_ORIGIN?: string }>(deps: OAuthDeps<Env>) {
  const providers = new Map<string, OAuthProvider<Env>>();

  return {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const origin = env.TERRARIUM_PUBLIC_ORIGIN?.trim();

      if (!origin) return deps.fallback(request, env, ctx);
      const provider = providers.get(origin) ?? createOAuthWorker(deps, origin);
      providers.set(origin, provider);

      return provider.fetch(request, env, ctx);
    },
  };
}
