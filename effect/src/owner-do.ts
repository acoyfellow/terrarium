import { DurableObject } from "cloudflare:workers";

import { ack, admitReserve, claim, finish, getRun, listRuns, migrate, toReply } from "./owner-store.ts";
import type { AdmitReservation, ClaimRequest, Sql, SqlValue } from "./owner-store.ts";
import type { RunTerminal } from "./shared.ts";

export class OwnerDO extends DurableObject {
  private readonly sql: Sql;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = { rows: (query: string, ...bindings: ReadonlyArray<SqlValue>) => ctx.storage.sql.exec(query, ...bindings).toArray() };
    ctx.blockConcurrencyWhile(() => Promise.resolve(migrate(this.sql)));
  }

  admitReserve(reservation: AdmitReservation) {
    return toReply(admitReserve(this.sql, reservation));
  }

  get(runId: string) {
    return toReply(getRun(this.sql, runId));
  }

  finish(runId: string, terminal: RunTerminal, logs: string) {
    return toReply(finish(this.sql, runId, terminal, logs));
  }

  list(channel: string | null, limit: number) {
    return toReply(listRuns(this.sql, channel, limit));
  }

  claim(request: ClaimRequest) {
    return toReply(claim(this.sql, request));
  }

  ack(subscriberId: string, eventId: string) {
    return toReply(ack(this.sql, subscriberId, eventId));
  }
}
