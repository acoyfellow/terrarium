import { test } from "node:test";
import assert from "node:assert/strict";
import { Schema } from "effect";

import { handleMcp, REMOTE_TOOLS, toolRequest } from "../src/remote-mcp.ts";
import { authorizeHandler, identityFromProps } from "../src/oauth-authorize.ts";
import type { ConsentFlow } from "../src/oauth-authorize.ts";
import type { Identity } from "../src/identity.ts";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

const ToolsBody = Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }) });

const CallBody = Schema.Struct({ result: Schema.Struct({ isError: Schema.Boolean, content: Schema.Array(Schema.Struct({ text: Schema.String })) }) });

const ErrorBody = Schema.Struct({ error: Schema.Struct({ code: Schema.Number }) });

const decodeBody = <S extends Schema.Decoder<unknown>>(schema: S, response: Response) => response.json().then(Schema.decodeUnknownPromise(schema));

const ada: Identity = { id: "user:ada:example.com", method: "access-user", email: "ada@example.com" };

type RpcBody = { readonly jsonrpc: "2.0"; readonly id: number; readonly method: string; readonly params?: { readonly name: string; readonly arguments?: Readonly<Record<string, string>> } };

const rpc = (body: RpcBody) => new Request("https://terrarium.example/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("tools/list offers the stable run and loop tools", async () => {
  const response = await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), ada, async () => new Response("unused"));
  const body = await decodeBody(ToolsBody, response);
  assert.deepEqual(body.result.tools.map((tool) => tool.name), REMOTE_TOOLS.map((tool) => tool.name));
  assert.ok(body.result.tools.some((tool) => tool.name === "terrarium_spawn"));
});

test("a tool call runs as the token's owner against the existing route", async () => {
  const seen: Request[] = [];

  const response = await handleMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "terrarium_status", arguments: { runId: "ter_1" } } }), ada, async (inner) => {
    seen.push(inner);

    return Response.json({ ok: true, runId: "ter_1" });
  });

  const body = await decodeBody(CallBody, response);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].url).pathname, "/api/runs/ter_1/status");
  assert.equal(seen[0].method, "GET");
  assert.equal(body.result.isError, false);
  assert.match(body.result.content[0].text, /ter_1/);
});

test("a run id cannot climb out of the runs route", () => {
  const request = toolRequest("https://terrarium.example", "terrarium_status", { runId: "../loops" });
  assert.equal(new URL(request?.url ?? "").pathname, "/api/runs/..%2Floops/status");
});

test("spawn sends an idempotency key and refuses a missing task", () => {
  assert.equal(toolRequest("https://terrarium.example", "terrarium_spawn", {}), null);
  const request = toolRequest("https://terrarium.example", "terrarium_spawn", { task: "echo hi" });
  assert.ok(request?.headers.get("idempotency-key"));
});

test("an unknown tool is an error and never reaches a route", async () => {
  let calls = 0;

  const response = await handleMcp(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "terrarium_delete_everything" } }), ada, async () => { calls += 1;

 return new Response(); });

  const body = await decodeBody(ErrorBody, response);
  assert.equal(calls, 0);
  assert.equal(body.error.code, -32602);
});

test("only an Access user's id becomes an MCP identity", () => {
  assert.deepEqual(identityFromProps({ id: "user:ada:example.com", email: "ada@example.com" }), ada);
  assert.equal(identityFromProps({ id: "ci-bot", email: null }), null);
  assert.equal(identityFromProps(null), null);
});

const authRequest: AuthRequest = { responseType: "code", clientId: "client-1", redirectUri: "https://evil.example/cb", scope: [], state: "s" };

const notCalled = () => Promise.reject(new Error("not expected in this test"));

const unusedOAuth: ConsentFlow = {
  parseAuthRequest: notCalled,
  describeConsent: notCalled,
  beginConsent: notCalled,
  approveConsent: notCalled,
  denyConsent: notCalled,
  completeAuthorization: notCalled,
};

test("authorize refuses anyone Access did not sign in", async () => {
  const handler = authorizeHandler({ accessIdentity: async () => null, asOwner: async () => new Response(), fallback: async () => new Response() });
  const response = await handler(new Request("https://terrarium.example/oauth/authorize?client_id=x"), { OAUTH_PROVIDER: unusedOAuth });
  assert.equal(response.status, 401);
});

test("the consent page escapes a client-chosen name", async () => {
  const handler = authorizeHandler({ accessIdentity: async () => ada, asOwner: async () => new Response(), fallback: async () => new Response() });

  const oauth = {
    ...unusedOAuth,
    parseAuthRequest: async () => authRequest,
    describeConsent: async () => ({ clientId: "client-1", clientName: "<script>x</script>", redirectHost: "evil.example", redirectIsLoopback: false, redirectUri: "https://evil.example/cb", scope: [] }),
    beginConsent: async () => ({ handle: "h1", headers: new Headers() }),
  };

  const response = await handler(new Request("https://terrarium.example/oauth/authorize"), { OAUTH_PROVIDER: oauth });
  const html = await response.text();
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /evil\.example/);
});
