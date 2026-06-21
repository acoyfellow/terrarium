import { Effect, PubSub, Stream } from 'effect';

/**
 * Typed Terrarium event bus.
 * Public API is internal-only; MCP surface remains unchanged.
 */
export const TerrariumEventType = Object.freeze({
  Started: 'Started',
  Progress: 'Progress',
  Completed: 'Completed',
  Failed: 'Failed',
  TimedOut: 'TimedOut',
  Cancelled: 'Cancelled',
});

const bus = await Effect.runPromise(PubSub.unbounded());

export function publishEvent(event) {
  return Effect.runPromise(PubSub.publish(bus, event));
}

export function subscribeEvents() {
  return Effect.runPromise(PubSub.subscribe(bus));
}

export function streamEvents() {
  return Stream.fromPubSub(bus);
}

export function eventForRun(type, run, extra = {}) {
  const terminal = new Set([TerrariumEventType.Completed, TerrariumEventType.Failed, TerrariumEventType.TimedOut, TerrariumEventType.Cancelled]);
  const eventId = extra.eventId ?? (terminal.has(type) ? `evt_${run.runId}_${type}` : undefined);
  return {
    type,
    ...(eventId ? { eventId } : {}),
    runId: run.runId,
    parentRunId: run.parentRunId ?? null,
    cwd: run.originalCwd ?? run.cwd,
    task: run.task,
    workflowId: run.workflowId ?? run.parentRunId ?? run.runId,
    sessionId: run.sessionId ?? null,
    channel: run.channel ?? process.env.TERRARIUM_EVENT_CHANNEL ?? null,
    at: new Date().toISOString(),
    ...extra,
  };
}
