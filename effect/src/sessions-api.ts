import { Effect, Schema } from "effect";

import { ProbeBoxes } from "./egress.ts";
import { BadRequest, Conflict, Owner, Upstream } from "./shared.ts";
import type { HttpFailure } from "./shared.ts";

const TurnBody = Schema.Struct({ text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)) });

const SESSION_NAME = new RegExp("^[A-Za-z0-9_-]{1,64}$");

export const sessionKey = (ownerId: string, name: string) => `${ownerId}::${name}`;

const validName = (name: string) => (SESSION_NAME.test(name) ? Effect.succeed(name) : Effect.fail(new BadRequest({ problems: ["session name must be 1-64 letters, digits, _ or -"] })));

export const sessionTurn = (request: Request, name: string): Effect.Effect<Response, HttpFailure, Owner | ProbeBoxes> =>
  Effect.gen(function* () {
    const owner = yield* Owner;
    const boxes = yield* ProbeBoxes;
    const valid = yield* validName(name);
    const raw = yield* Effect.tryPromise({ try: () => request.json(), catch: () => new BadRequest({ problems: ["body must be JSON"] }) });
    const body = yield* Schema.decodeUnknownEffect(TurnBody)(raw).pipe(Effect.mapError(() => new BadRequest({ problems: ["body must be {text} with 1-8000 characters"] })));
    const startedMs = Date.now();
    const turn = yield* Effect.tryPromise({ try: () => boxes.session(sessionKey(owner.id, valid)).turn(body.text), catch: (cause) => new Upstream({ service: "session", detail: String(cause) }) });

    return Response.json({ ok: true, session: valid, ms: Date.now() - startedMs, ...turn });
  });

export const sessionSteer = (request: Request, name: string): Effect.Effect<Response, HttpFailure, Owner | ProbeBoxes> =>
  Effect.gen(function* () {
    const owner = yield* Owner;
    const boxes = yield* ProbeBoxes;
    const valid = yield* validName(name);
    const raw = yield* Effect.tryPromise({ try: () => request.json(), catch: () => new BadRequest({ problems: ["body must be JSON"] }) });
    const body = yield* Schema.decodeUnknownEffect(TurnBody)(raw).pipe(Effect.mapError(() => new BadRequest({ problems: ["body must be {text} with 1-8000 characters"] })));
    const result = yield* Effect.tryPromise({ try: () => boxes.session(sessionKey(owner.id, valid)).steer(body.text), catch: (cause) => new Upstream({ service: "session", detail: String(cause) }) });

    return result.steered ? Response.json({ ok: true, session: valid, ...result }, { status: 202 }) : yield* new Conflict({ reason: result.reason });
  });

export const sessionReplaceBox = (name: string): Effect.Effect<Response, HttpFailure, Owner | ProbeBoxes> =>
  Effect.gen(function* () {
    const owner = yield* Owner;
    const boxes = yield* ProbeBoxes;
    const valid = yield* validName(name);
    const replaced = yield* Effect.tryPromise({ try: () => boxes.session(sessionKey(owner.id, valid)).replaceBox(), catch: (cause) => new Upstream({ service: "session", detail: String(cause) }) });

    return Response.json({ ok: true, session: valid, ...replaced });
  });
