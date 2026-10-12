import test from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, Schema } from "effect";
import { Owner } from "../src/shared.ts";
import { createLoop, getLoop, listLoops } from "../src/loops-api.ts";
import type { LoopInstanceStatus, LoopsEnv } from "../src/loops-api.ts";

const makeEnv = (): LoopsEnv => {
  const kv = new Map<string, string>();
  const instances = new Set<string>();
  const status: LoopInstanceStatus = { status: "running" };

  return {
    LOOPS_KV: { get: (key) => Promise.resolve(kv.get(key) ?? null), put: (key, value) => Promise.resolve(void kv.set(key, value)) },
    LOOP_WORKFLOW: {
      create: (options) => Promise.resolve(void instances.add(options.id)).then(() => ({ id: options.id })),
      get: (id) => (instances.has(id) ? Promise.resolve({ status: () => Promise.resolve(status), terminate: () => Promise.resolve() }) : Promise.reject(new Error("no instance"))),
    },
  };
};

const as = (id: string) => Layer.succeed(Owner, { id, method: "bearer", email: null });

const respond = (program: Effect.Effect<Response, unknown, Owner>, ownerId: string) =>
  Effect.runPromise(program.pipe(Effect.provide(as(ownerId)), Effect.match({ onFailure: (error) => error, onSuccess: (response) => response })));

const post = (body: string) => new Request("https://t/api/loops", { method: "POST", body });

const Created = Schema.Struct({ loopId: Schema.String, contract: Schema.Unknown });

const Listed = Schema.Struct({ loops: Schema.Array(Schema.Struct({ loopId: Schema.String, status: Schema.String })) });

const read = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, response: Response) => response.json().then(Schema.decodeUnknownPromise(schema));

const contract = { goal: "multiply", task: "17*23?", expect: "391", maxAttempts: 2 };

test("create, list and get a loop", async () => {
  const env = makeEnv();
  const created = await respond(createLoop(post(JSON.stringify(contract)), env), "alice");
  assert.ok(created instanceof Response);
  assert.equal(created.status, 202);
  const body = await read(Created, created);
  assert.match(body.loopId, /^loop_[a-z0-9]{8,40}$/);
  assert.deepEqual(body.contract, contract);
  const listed = await respond(listLoops(new Request("https://t/api/loops"), env), "alice");
  assert.ok(listed instanceof Response);
  const list = await read(Listed, listed);
  assert.equal(list.loops.length, 1);
  assert.equal(list.loops[0].status, "running");
  const got = await respond(getLoop(new Request(`https://t/api/loops/${body.loopId}`), env), "alice");
  assert.ok(got instanceof Response);
  assert.equal((await read(Created, got)).loopId, body.loopId);
});

test("invalid contract is BadRequest", async () => {
  const env = makeEnv();
  const missing = await respond(createLoop(post(JSON.stringify({ goal: "g", task: "t" })), env), "alice");
  assert.ok(!(missing instanceof Response));
  assert.deepEqual(Object(missing)._tag, "BadRequest");
  const tooMany = await respond(createLoop(post(JSON.stringify({ ...contract, maxAttempts: 6 })), env), "alice");
  assert.deepEqual(Object(tooMany)._tag, "BadRequest");
  const notJson = await respond(createLoop(post("{"), env), "alice");
  assert.deepEqual(Object(notJson)._tag, "BadRequest");
});

test("another owner gets 404 and an empty list", async () => {
  const env = makeEnv();
  const created = await respond(createLoop(post(JSON.stringify(contract)), env), "alice");
  assert.ok(created instanceof Response);
  const { loopId } = await read(Created, created);
  const got = await respond(getLoop(new Request(`https://t/api/loops/${loopId}`), env), "mallory");
  assert.deepEqual(Object(got)._tag, "NotFound");
  const listed = await respond(listLoops(new Request("https://t/api/loops"), env), "mallory");
  assert.ok(listed instanceof Response);
  assert.deepEqual(await read(Listed, listed), { loops: [] });
});
