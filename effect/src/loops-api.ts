import { Effect, Schema } from "effect";
import { BadRequest, NotFound, Owner, Upstream } from "./shared.ts";
import type { HttpFailure } from "./shared.ts";
import { LoopContract } from "./loop-decide.ts";

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
  readonly get: (id: string) => Promise<{ readonly status: () => Promise<LoopInstanceStatus>; readonly terminate: () => Promise<void> }>;
}

export interface LoopsEnv {
  readonly LOOPS_KV: LoopsKv;
  readonly LOOP_WORKFLOW: LoopWorkflowBinding;
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
    const loopId = `loop_${crypto.randomUUID().replaceAll("-", "")}`;
    const loops = yield* readIndex(env, owner.id);
    yield* Effect.tryPromise({ try: () => env.LOOP_WORKFLOW.create({ id: loopId, params: { loopId, ownerId: owner.id, contract } }), catch: upstream("workflow") });
    const record: LoopRecord = { loopId, contract, createdAt: new Date().toISOString() };
    const encoded = yield* Schema.encodeEffect(LoopIndex)([record, ...loops]).pipe(Effect.mapError(upstream("kv")));
    yield* Effect.tryPromise({ try: () => env.LOOPS_KV.put(indexKey(owner.id), encoded), catch: upstream("kv") });

    return json({ loopId, contract }, 202);
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
