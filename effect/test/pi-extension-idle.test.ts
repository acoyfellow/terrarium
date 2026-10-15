import assert from "node:assert/strict";
import test from "node:test";

import terrariumEffect from "../pi-extension/index.ts";

type Handler = (event: { readonly toolName: string; readonly input: { readonly background?: boolean }; readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }) => void;

const fakePi = () => {
  const handlers: Array<Handler> = [];
  const messages: Array<string> = [];

  return {
    handlers,
    messages,
    pi: { on: (_event: "tool_result", handler: Handler) => void handlers.push(handler), sendUserMessage: (content: string) => void messages.push(content) },
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
  process.env.TERRARIUM_URL = "https://t.example";
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
