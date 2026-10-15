import { DatabaseSync } from "node:sqlite";

import * as store from "../src/owner-store.ts";
import type { Sql, SqlValue } from "../src/owner-store.ts";
import type { AppEnv } from "../src/app.ts";
import type { OwnerRpc, RunParams } from "../src/runs.ts";

const sqlite = (): Sql => {
  const db = new DatabaseSync(":memory:");

  return { rows: (query: string, ...bindings: ReadonlyArray<SqlValue>) => db.prepare(query).all(...bindings) };
};

const ownerRpc = (): OwnerRpc => {
  const sql = sqlite();
  store.migrate(sql);

  return {
    admitReserve: (reservation) => Promise.resolve(store.toReply(store.admitReserve(sql, reservation))),
    get: (runId) => Promise.resolve(store.toReply(store.getRun(sql, runId))),
    finish: (runId, terminal, logs) => Promise.resolve(store.toReply(store.finish(sql, runId, terminal, logs))),
    beginStart: (runId, nowMs) => Promise.resolve(store.toReply(store.beginStart(sql, runId, nowMs))),
    list: (channel, limit) => Promise.resolve(store.toReply(store.listRuns(sql, channel, limit))),
    claim: (request) => Promise.resolve(store.toReply(store.claim(sql, request))),
    ack: (subscriberId, eventId) => Promise.resolve(store.toReply(store.ack(sql, subscriberId, eventId))),
  };
};

export const principals = [{ id: "alice-bot", token: "alice-token-0123456789" }, { id: "bob-bot", token: "bob-token-0123456789" }];

export const fakeEnv = (): AppEnv & { readonly started: Array<RunParams> } => {
  const owners = new Map<string, OwnerRpc>();
  const kv = new Map<string, string>();
  const started: Array<RunParams> = [];

  const getByName = (name: string) => {
    const existing = owners.get(name) ?? ownerRpc();
    owners.set(name, existing);

    return existing;
  };

  return {
    started,
    OWNER: { getByName },
    RUN_WORKFLOW: {
      create: (options) => Promise.resolve(void started.push(options.params)).then(() => ({ id: options.id })),
      get: () => Promise.resolve({ terminate: () => Promise.resolve() }),
    },
    LOOPS_KV: { get: (key) => Promise.resolve(kv.get(key) ?? null), put: (key, value) => Promise.resolve(void kv.set(key, value)) },
    LOOP_WORKFLOW: {
      create: (options) => Promise.resolve({ id: options.id }),
      get: () => Promise.resolve({ status: () => Promise.resolve({ status: "running" }), terminate: () => Promise.resolve() }),
    },
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) },
    TERRARIUM_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    TERRARIUM_ACCESS_AUD: "aud",
    TERRARIUM_PRINCIPALS: JSON.stringify(principals),
  };
};
