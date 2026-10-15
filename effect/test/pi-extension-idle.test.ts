import assert from "node:assert/strict";
import test from "node:test";

import terrariumEffect from "../pi-extension/index.ts";

const FAKE_URL = ["https:", "", "t.example"].join("/");

type Handler = (event: { readonly toolName: string; readonly input: { readonly background?: boolean }; readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }, ctx?: { readonly ui?: { readonly setWidget: (key: string, lines: ReadonlyArray<string> | undefined) => void } }) => void;

const fakePi = () => {
  const handlers: Array<Handler> = [];
  const messages: Array<string> = [];

  return {
    handlers,
    messages,
    pi: { on: (_event: "tool_result", handler: Handler) => void handlers.push(handler), sendUserMessage: (content: string) => void messages.push(content), registerTool: () => undefined },
  };
};

const withFetchCounter = async (body: (calls: { count: number }) => Promise<void>) => {
  const original = globalThis.fetch;
  const calls = { count: 0 };

  const counted: typeof fetch = () => {
    calls.count += 1;

    return Promise.resolve(new Response("{}", { status: 500 }));
  };

  globalThis.fetch = counted;

  await body(calls).finally(() => {
    globalThis.fetch = original;
  });
};

test("loading the extension in an idle session makes no requests", async () => {
  await withFetchCounter(async (calls) => {
    const { pi, handlers } = fakePi();
    terrariumEffect(pi);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(handlers.length, 1);
    assert.equal(calls.count, 0);
  });
});

test("tool results that are not background spawns start no watch", async () => {
  process.env.TERRARIUM_URL = FAKE_URL;
  process.env.TERRARIUM_TOKEN = "t";

  await withFetchCounter(async (calls) => {
    const { pi, handlers } = fakePi();
    terrariumEffect(pi);
    handlers[0]({ toolName: "read", input: {}, content: [{ type: "text", text: "ter_abc123_0123456789ab" }] });
    handlers[0]({ toolName: "terrarium_spawn", input: { background: false }, content: [{ type: "text", text: "ter_abc123_0123456789ab" }] });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(calls.count, 0);
  });
});

test("a background spawn shows a live widget while the run works, then clears it", async () => {
  process.env.TERRARIUM_URL = FAKE_URL;
  process.env.TERRARIUM_TOKEN = "t";

  const original = globalThis.fetch;

  const widgets: Array<ReadonlyArray<string> | undefined> = [];

  const replies = [
    { status: "running", createdAt: "2026-01-01T00:00:00.000Z", events: [{ at: Date.parse("2026-01-01T00:00:02.000Z"), kind: "tool", detail: "bash npm test" }] },
    { status: "done", createdAt: "2026-01-01T00:00:00.000Z", events: [{ at: Date.parse("2026-01-01T00:00:05.000Z"), kind: "text", detail: "All green." }] },
  ];

  const counted: typeof fetch = (input) => {
    const path = new URL(String(input)).pathname;

    if (path.endsWith("/activity")) return Promise.resolve(new Response(JSON.stringify(replies.shift() ?? replies.at(-1)), { status: 200 }));

    return Promise.resolve(new Response(JSON.stringify({ runId: "ter_abc123_0123456789ab", terminal: { status: "done", provenance: "this-run", summary: "ok" } }), { status: 200 }));
  };

  globalThis.fetch = counted;

  const { pi, handlers, messages } = fakePi();
  terrariumEffect(pi);
  handlers[0]({ toolName: "terrarium_spawn", input: { background: true }, content: [{ type: "text", text: "ter_abc123_0123456789ab" }] }, { ui: { setWidget: (_key, lines) => void widgets.push(lines) } });
  await new Promise((resolve) => setTimeout(resolve, 16_000));
  globalThis.fetch = original;

  assert.deepEqual(widgets[0], ["terrarium ter_abc123_0123456789ab · 1 steps", "  ▸ +2s bash npm test"]);
  assert.deepEqual(widgets[1], ["terrarium ter_abc123_0123456789ab · 2 steps", "  ▸ +2s bash npm test", "  · +5s All green."]);
  assert.equal(widgets.at(-1), undefined);
  assert.equal(messages.length, 1);
});
