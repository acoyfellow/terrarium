import { Effect, Schema } from "effect";
import { BadRequest, NotFound, Owner, Upstream } from "./shared.ts";
import type { HttpFailure } from "./shared.ts";
import { LoopContract, hasCheck } from "./loop-decide.ts";
import { MAX_NOTE, WAKE_EVENT, hookSignature, sameText } from "./wake.ts";
import type { WakePayload } from "./wake.ts";

export interface LoopsKv {
  readonly get: (key: string) => Promise<string | null>;
  readonly put: (key: string, value: string) => Promise<void>;
}

export interface LoopInstanceStatus {
  readonly status: string;
  readonly output?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}

export interface LoopWorkflowBinding {
  readonly create: (options: { readonly id: string; readonly params: { readonly loopId: string; readonly ownerId: string; readonly contract: LoopContract } }) => Promise<{ readonly id: string }>;
  readonly get: (id: string) => Promise<{ readonly status: () => Promise<LoopInstanceStatus>; readonly terminate: () => Promise<void>; readonly sendEvent: (event: { readonly type: string; readonly payload: WakePayload }) => Promise<void> }>;
}

export interface LoopsEnv {
  readonly LOOPS_KV: LoopsKv;
  readonly LOOP_WORKFLOW: LoopWorkflowBinding;
  readonly TERRARIUM_HOOK_SECRET?: string;
}

const LoopRecord = Schema.Struct({ loopId: Schema.String, contract: LoopContract, createdAt: Schema.String });

type LoopRecord = typeof LoopRecord.Type;

const LoopIndex = Schema.fromJsonString(Schema.Array(LoopRecord));

const upstream = (service: string) => (cause: unknown) => new Upstream({ service, detail: String(cause) });

const json = <A>(body: A, status = 200) => Response.json(body, { status });

const indexKey = (ownerId: string) => `loops:${ownerId}`;

const readIndex = (env: LoopsEnv, ownerId: string) =>
  Effect.tryPromise({ try: () => env.LOOPS_KV.get(indexKey(ownerId)), catch: upstream("kv") }).pipe(
    Effect.flatMap((raw) => (raw === null ? Effect.succeed([]) : Schema.decodeUnknownEffect(LoopIndex)(raw).pipe(Effect.mapError(upstream("kv"))))),
  );

const witness = (env: LoopsEnv, loop: LoopRecord) =>
  Effect.tryPromise({ try: () => env.LOOP_WORKFLOW.get(loop.loopId).then((instance) => instance.status()), catch: upstream("workflow") }).pipe(
    Effect.map((instance) => ({ ...loop, status: instance.status, output: instance.output ?? null, error: instance.error ?? null })),
  );

export const createLoop = (request: Request, env: LoopsEnv): Effect.Effect<Response, HttpFailure, Owner> =>
  Effect.gen(function* () {
    const owner = yield* Owner;
    const body = yield* Effect.tryPromise({ try: () => request.json(), catch: () => new BadRequest({ problems: ["body must be JSON"] }) });
    const contract = yield* Schema.decodeUnknownEffect(LoopContract)(body).pipe(Effect.mapError((error) => new BadRequest({ problems: [error.message] })));

    if (!hasCheck(contract)) return yield* new BadRequest({ problems: ["a loop needs expect, proof, or both"] });
    const loopId = `loop_${crypto.randomUUID().replaceAll("-", "")}`;
    const loops = yield* readIndex(env, owner.id);
    yield* Effect.tryPromise({ try: () => env.LOOP_WORKFLOW.create({ id: loopId, params: { loopId, ownerId: owner.id, contract } }), catch: upstream("workflow") });
    const record: LoopRecord = { loopId, contract, createdAt: new Date().toISOString() };
    const encoded = yield* Schema.encodeEffect(LoopIndex)([record, ...loops]).pipe(Effect.mapError(upstream("kv")));
    yield* Effect.tryPromise({ try: () => env.LOOPS_KV.put(indexKey(owner.id), encoded), catch: upstream("kv") });

    const hook = yield* hookFor(env, loopId);

    return json(hook === null ? { loopId, contract } : { loopId, contract, hook }, 202);
  });

export const listLoops = (_request: Request, env: LoopsEnv): Effect.Effect<Response, HttpFailure, Owner> =>
  Effect.gen(function* () {
    const owner = yield* Owner;
    const loops = yield* readIndex(env, owner.id);
    const witnessed = yield* Effect.forEach(loops, (loop) => witness(env, loop), { concurrency: 8 });

    return json({ loops: witnessed });
  });

export const getLoop = (request: Request, env: LoopsEnv): Effect.Effect<Response, HttpFailure, Owner> =>
  Effect.gen(function* () {
    const owner = yield* Owner;
    const loopId = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const loops = yield* readIndex(env, owner.id);
    const loop = loops.find((candidate) => candidate.loopId === loopId);

    if (loop === undefined) return yield* new NotFound({ what: "loop" });

    return json(yield* witness(env, loop));
  });

const ownedLoop = (request: Request, env: LoopsEnv, ownerId: string) => Effect.gen(function* () {
  const loopId = new URL(request.url).pathname.split("/")[3] ?? "";
  const loops = yield* readIndex(env, ownerId);
  const loop = loops.find((candidate) => candidate.loopId === loopId);

  return loop === undefined ? yield* new NotFound({ what: "loop" }) : { loop, loops };
});

const stopWorkflow = (env: LoopsEnv, loopId: string) =>
  Effect.tryPromise({ try: () => env.LOOP_WORKFLOW.get(loopId).then((instance) => instance.terminate()), catch: upstream("workflow") });

export const cancelLoop = (request: Request, env: LoopsEnv): Effect.Effect<Response, HttpFailure, Owner> =>
  Effect.gen(function* () {
    const owner = yield* Owner;
    const { loop } = yield* ownedLoop(request, env, owner.id);
    yield* stopWorkflow(env, loop.loopId);

    return json(yield* witness(env, loop));
  });

export const deleteLoop = (request: Request, env: LoopsEnv): Effect.Effect<Response, HttpFailure, Owner> =>
  Effect.gen(function* () {
    const owner = yield* Owner;
    const { loop, loops } = yield* ownedLoop(request, env, owner.id);
    yield* Effect.ignore(stopWorkflow(env, loop.loopId));
    const encoded = yield* Schema.encodeEffect(LoopIndex)(loops.filter((candidate) => candidate.loopId !== loop.loopId)).pipe(Effect.mapError(upstream("kv")));
    yield* Effect.tryPromise({ try: () => env.LOOPS_KV.put(indexKey(owner.id), encoded), catch: upstream("kv") });

    return json({ ok: true, loopId: loop.loopId });
  });

const WakeBody = Schema.Struct({ source: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(80))), note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_NOTE))) });

const wakeBodyOf = (request: Request) =>
  Effect.tryPromise({ try: () => request.text(), catch: () => new BadRequest({ problems: ["unreadable body"] }) }).pipe(
    Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(WakeBody))(text.length === 0 ? "{}" : text).pipe(Effect.mapError((error) => new BadRequest({ problems: [error.message] })))),
  );

const sendWake = (env: LoopsEnv, loopId: string, payload: WakePayload) =>
  Effect.tryPromise({ try: () => env.LOOP_WORKFLOW.get(loopId).then((instance) => instance.sendEvent({ type: WAKE_EVENT, payload })), catch: upstream("workflow") });

const hookFor = (env: LoopsEnv, loopId: string) => {
  const secret = env.TERRARIUM_HOOK_SECRET ?? "";

  if (secret.length === 0) return Effect.succeed(null);

  return Effect.promise(() => hookSignature(secret, loopId)).pipe(Effect.map((sig) => `/hooks/loops/${loopId}/wake?sig=${sig}`));
};

export const wakeLoop = (request: Request, env: LoopsEnv): Effect.Effect<Response, HttpFailure, Owner> =>
  Effect.gen(function* () {
    const owner = yield* Owner;
    const { loop } = yield* ownedLoop(request, env, owner.id);
    const body = yield* wakeBodyOf(request);
    const payload: WakePayload = { source: body.source ?? `owner:${owner.id}`, note: body.note ?? "" };
    yield* sendWake(env, loop.loopId, payload);

    return json({ ok: true, loopId: loop.loopId, woke: payload }, 202);
  });

export const hookWake = (request: Request, env: LoopsEnv): Effect.Effect<Response, HttpFailure> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const loopId = url.pathname.split("/")[3] ?? "";
    const secret = env.TERRARIUM_HOOK_SECRET ?? "";
    const given = url.searchParams.get("sig") ?? "";

    if (secret.length === 0 || !/^loop_[0-9a-f]{32}$/.test(loopId)) return yield* new NotFound({ what: "hook" });

    const expected = yield* Effect.promise(() => hookSignature(secret, loopId));

    if (!sameText(given, expected)) return yield* new NotFound({ what: "hook" });

    const body = yield* wakeBodyOf(request);
    const payload: WakePayload = { source: body.source ?? "hook", note: body.note ?? "" };
    yield* sendWake(env, loopId, payload);

    return json({ ok: true, loopId, woke: payload }, 202);
  });
