import { readFile } from "node:fs/promises";
import { initialRunState, transition, RUN_MACHINE_VERSION } from "./run-machine.js";

export const SCHEDULE_FIXTURE_VERSION = 1;
const ALLOWED_INVARIANTS = new Set(["at-most-one-terminal", "at-most-one-callback", "terminal-callback-paired"]);

export function replayScheduleFixture(fixture) {
  validateFixture(fixture);
  let state = initialRunState(fixture.initialState);
  const steps = [];
  const decisions = [];
  for (const input of fixture.orderedInputs) {
    const result = transition(state, input);
    state = result.state;
    decisions.push(...result.decisions);
    steps.push({ input, decisions: result.decisions, phase: state.phase, terminalStatus: state.terminal?.status ?? null });
  }
  const terminalCount = decisions.filter((d) => d.type === "Finalize").length;
  const callbackCount = decisions.filter((d) => d.type === "QueueCallback").length;
  const checks = fixture.invariants.map((invariant) => ({ invariant, passed: checkInvariant(invariant, terminalCount, callbackCount) }));
  if (fixture.expected?.terminalStatus) checks.push({ invariant: "expected-terminal-status", passed: state.terminal?.status === fixture.expected.terminalStatus, expected: fixture.expected.terminalStatus, actual: state.terminal?.status ?? null });
  return {
    ok: checks.every((check) => check.passed),
    fixtureVersion: fixture.version,
    machineVersion: RUN_MACHINE_VERSION,
    id: fixture.id,
    affectedRevision: fixture.affectedRevision,
    terminal: state.terminal,
    terminalCount,
    callbackCount,
    checks,
    steps,
  };
}

export async function replayScheduleFile(path) {
  return replayScheduleFixture(JSON.parse(await readFile(path, "utf8")));
}

function checkInvariant(invariant, terminalCount, callbackCount) {
  if (invariant === "at-most-one-terminal") return terminalCount <= 1;
  if (invariant === "at-most-one-callback") return callbackCount <= 1;
  if (invariant === "terminal-callback-paired") return terminalCount === callbackCount;
  return false;
}

function validateFixture(fixture) {
  if (!fixture || fixture.version !== SCHEDULE_FIXTURE_VERSION) throw new Error(`unsupported schedule fixture version: ${fixture?.version}`);
  if (typeof fixture.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(fixture.id)) throw new Error("invalid schedule fixture id");
  if (typeof fixture.affectedRevision !== "string" || !/^[0-9a-f]{7,40}$/.test(fixture.affectedRevision)) throw new Error("schedule fixture requires a git revision");
  if (!fixture.initialState || typeof fixture.initialState.requireReceipt !== "boolean") throw new Error("schedule fixture requires bounded initial state");
  if (!Array.isArray(fixture.orderedInputs) || fixture.orderedInputs.length < 1 || fixture.orderedInputs.length > 64) throw new Error("schedule fixture requires 1-64 ordered inputs");
  if (!Array.isArray(fixture.invariants) || fixture.invariants.length < 1 || fixture.invariants.some((value) => !ALLOWED_INVARIANTS.has(value))) throw new Error("schedule fixture contains an unsupported invariant");
  // Keep fixtures portable and secret-free: only allow classification facts.
  for (const input of fixture.orderedInputs) {
    const allowed = new Set(input.type === "ChildExited" ? ["type", "exitCode", "signal"] : input.type === "ReceiptObserved" ? ["type", "status"] : ["type"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error(`schedule input ${input.type} contains private or unsupported fields`);
  }
}
