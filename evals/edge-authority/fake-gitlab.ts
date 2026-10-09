export type UpstreamHit = {
  method: string;
  path: string;
  authorized: boolean;
  bodyKeys: string[];
};

export type FakeGitlab = {
  url: string;
  hits: UpstreamHit[];
  stop: () => void;
};

function bodyKeysOf(text: string): string[] {
  if (text === "") return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [];
  } catch {
    return Object.keys(Object.fromEntries(new URLSearchParams(text)));
  }
}

export function startFakeGitlab(realToken: string): FakeGitlab {
  const hits: UpstreamHit[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    async fetch(request) {
      const url = new URL(request.url);
      const presented = request.headers.get("private-token") ?? request.headers.get("authorization")?.replace(new RegExp("^Bearer\\s+", "i"), "") ?? "";
      const authorized = presented === realToken;
      const body = request.method === "GET" ? "" : await request.text();
      hits.push({ method: request.method, path: url.pathname, authorized, bodyKeys: bodyKeysOf(body) });
      if (!authorized) return Response.json({ message: "401 Unauthorized" }, { status: 401 });
      if (url.pathname === "/api/v4/user") return Response.json({ username: "fake-owner" });
      return Response.json({ ok: true, path: url.pathname }, { status: request.method === "POST" ? 201 : 200 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}
