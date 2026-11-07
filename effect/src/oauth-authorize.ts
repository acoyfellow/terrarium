import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Option, Schema } from "effect";

import type { Identity } from "./identity.ts";

export const MCP_PATH = "/mcp";

export const AUTHORIZE_PATH = "/oauth/authorize";

export const TOKEN_PATH = "/oauth/token";

export const REGISTER_PATH = "/oauth/register";

export const MCP_SCOPE = "terrarium";

export const ACCESS_TOKEN_TTL_SECONDS = 3600;

export type McpProps = { readonly id: string; readonly email: string | null };

export interface OAuthDeps<Env> {
  readonly accessIdentity: (request: Request, env: Env) => Promise<Identity | null>;
  readonly asOwner: (request: Request, env: Env, identity: Identity) => Promise<Response>;
  readonly fallback: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
}

export type ConsentFlow = Pick<OAuthHelpers, "parseAuthRequest" | "describeConsent" | "beginConsent" | "approveConsent" | "denyConsent" | "completeAuthorization">;

export type OAuthEnv = { readonly OAUTH_PROVIDER: ConsentFlow };

const GrantProps = Schema.Struct({ id: Schema.String.check(Schema.isStartingWith("user:")), email: Schema.NullOr(Schema.String) });

const decodeGrantProps = Schema.decodeUnknownOption(GrantProps);

export const identityFromProps = (props: ExecutionContext["props"]): Identity | null =>
  Option.match(decodeGrantProps(props), {
    onNone: () => null,
    onSome: (grant): Identity => ({ id: grant.id, method: "access-user", email: grant.email }),
  });

export const grantUserId = (ownerId: string) => encodeURIComponent(ownerId).replaceAll(":", "%3A");

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function consentPage(handle: string, clientName: string, redirectHost: string, email: string, headers: Headers): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Terrarium</title>
<style>body{font:15px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.6rem 1.2rem;margin-right:.5rem}</style></head>
<body><h1>Connect to Terrarium</h1>
<p><strong>${escapeHtml(clientName)}</strong> wants to start and read Terrarium runs as <strong>${escapeHtml(email)}</strong>.</p>
<p>Tokens go to <strong>${escapeHtml(redirectHost)}</strong>.</p>
<form method="post" action="${AUTHORIZE_PATH}"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve" type="submit">Allow</button><button name="decision" value="deny" type="submit">Deny</button></form></body></html>`;

  headers.set("content-type", "text/html; charset=utf-8");

  return new Response(body, { status: 200, headers });
}

export function authorizeHandler<Env extends OAuthEnv>(deps: OAuthDeps<Env>) {
  return async (request: Request, env: Env): Promise<Response> => {
    const identity = await deps.accessIdentity(request, env);

    if (!identity) return new Response("Sign in with Cloudflare Access first.", { status: 401 });
    const oauth = env.OAUTH_PROVIDER;

    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const consent = await oauth.describeConsent(authRequest);
      const transaction = await oauth.beginConsent(authRequest);

      return consentPage(transaction.handle, consent.clientName ?? "An MCP client", consent.redirectHost, identity.email ?? identity.id, transaction.headers);
    }

    if (request.method !== "POST") return new Response(null, { status: 405 });
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);

      return new Response(null, { status: 302, headers: denied.headers });
    }

    const approved = await oauth.approveConsent(request, handle, { scope: [MCP_SCOPE] });
    const props: McpProps = { id: identity.id, email: identity.email };
    const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: grantUserId(identity.id), metadata: { email: identity.email }, scope: [MCP_SCOPE], props });
    approved.headers.set("location", redirectTo);

    return new Response(null, { status: 302, headers: approved.headers });
  };
}
