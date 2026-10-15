import assert from "node:assert/strict";
import test from "node:test";

import { MAX_EVENTS, appendCapped, eventsOf, since, widgetLines } from "../src/activity.ts";

const call = (name: string, args: string) => ({ id: "c", type: "function" as const, function: { name, arguments: args } });

test("tool calls become one line each, with the command shown", () => {
  const events = eventsOf({ content: "", toolCalls: [call("bash", JSON.stringify({ command: "npm test\n  --silent" })), call("read", JSON.stringify({ path: "src/a.ts" }))] }, 5);

  assert.deepEqual(events.map((e) => e.detail), ["bash npm test --silent", "read src/a.ts"]);
  assert.equal(events.every((e) => e.kind === "tool" && e.at === 5), true);
});

test("assistant text is recorded after its tool calls", () => {
  const events = eventsOf({ content: "All done.", toolCalls: [call("bash", "{}")] }, 1);

  assert.deepEqual(events.map((e) => e.kind), ["tool", "text"]);
});

test("details are clipped and secret-looking values redacted", () => {
  const [event] = eventsOf({ content: `export API_KEY=abc123 ${"x".repeat(400)}`, toolCalls: [] }, 1);

  assert.equal(event.detail.includes("abc123"), false);
  assert.match(event.detail, /API_KEY=<redacted>/);
  assert.ok(event.detail.length <= 240);
});

test("the log keeps only the newest events", () => {
  const one = eventsOf({ content: "x", toolCalls: [] }, 1);
  const full = Array.from({ length: MAX_EVENTS + 10 }).reduce<ReturnType<typeof appendCapped>>((log, _, i) => appendCapped(log, eventsOf({ content: `e${i}`, toolCalls: [] }, i)), one);

  assert.equal(full.length, MAX_EVENTS);
  assert.equal(full.at(-1)?.detail, `e${MAX_EVENTS + 9}`);
});

test("since returns only newer events and the widget shows the last few", () => {
  const log = [1, 2, 3, 4, 5, 6].map((at) => ({ at: at * 1000, kind: "tool" as const, detail: `step ${at}` }));

  assert.equal(since(log, 4000).length, 2);
  assert.deepEqual(widgetLines("ter_x", log, 0, 2), ["terrarium ter_x · 6 steps", "  ▸ +5s step 5", "  ▸ +6s step 6"]);
});

test("receipt lines are not echoed into the activity view", () => {
  const [event] = eventsOf({ content: 'TERRARIUM_RESULT={"nonce":"abc","summary":"x"}', toolCalls: [] }, 1);

  assert.equal(event.detail, "TERRARIUM_RESULT=<receipt>");
});
