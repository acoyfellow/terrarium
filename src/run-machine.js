// Pure, testable single-run terminal decision core.
// No clocks, processes, files, callbacks, prompts, output, or environment access.

export const RUN_MACHINE_VERSION = 1;

export function initialRunState({ requireReceipt = true } = {}) {
  return {
    version: RUN_MACHINE_VERSION,
    phase: "running",
    requireReceipt,
    cancelRequested: false,
    deadlineReached: false,
    childExit: null,
    receipt: requireReceipt ? "pending" : "not-required",
    terminal: null,
  };
}

/**
 * transition(state, observedInput) -> { state, decisions }
 *
 * Inputs are already-observed facts; adapters own real clocks/processes/parsing.
 * Decisions are inert descriptions; production adapters own all I/O.
 */
export function transition(previous, input) {
  assertState(previous);
  assertInput(input);
  const state = structuredClone(previous);
  const decisions = [];

  if (state.phase === "terminal") {
    return { state, decisions: [{ type: "IgnoreLateInput", inputType: input.type, terminalStatus: state.terminal.status }] };
  }

  switch (input.type) {
    case "CancelRequested":
      if (!state.cancelRequested) {
        state.cancelRequested = true;
        decisions.push({ type: "TerminateChild", reason: "cancel-requested" });
      }
      break;

    case "DeadlineReached":
      if (!state.deadlineReached) {
        state.deadlineReached = true;
        decisions.push({ type: "TerminateChild", reason: "deadline-reached" });
      }
      break;

    case "ReceiptObserved":
      if (state.receipt !== "pending") {
        decisions.push({ type: "IgnoreLateInput", inputType: input.type, reason: "receipt-already-observed" });
        break;
      }
      state.receipt = input.status;
      if (input.status === "verified") {
        state.receiptSummary = input.summary;
        decisions.push({ type: "AcceptReceipt", summary: input.summary });
      }
      break;

    case "ChildExited":
      if (state.childExit) {
        decisions.push({ type: "IgnoreLateInput", inputType: input.type, reason: "child-exit-already-observed" });
        break;
      }
      state.childExit = { exitCode: input.exitCode, signal: input.signal ?? null };
      break;

    case "ProcessTerminated":
      // Acknowledges a previously-requested termination; child exit remains the
      // authoritative process result and is required before finalization.
      break;

    case "RuntimeError":
      state.childExit = { exitCode: input.exitCode ?? 127, signal: null, error: input.error };
      state.runtimeError = input.error;
      break;
  }

  const final = terminalDecision(state);
  if (final) {
    state.phase = "terminal";
    state.terminal = final;
    decisions.push({ type: "Finalize", ...final });
    decisions.push({ type: "QueueCallback", status: final.status, ok: final.ok });
  }
  return { state, decisions };
}

function terminalDecision(state) {
  if (!state.childExit) return null;

  // Cancellation/deadline intent wins if observed before terminal commit,
  // independent of the child's exit code or receipt arrival ordering.
  if (state.cancelRequested) return { status: "cancelled", ok: false, exitCode: state.childExit.exitCode, signal: state.childExit.signal, taskContractStatus: state.receipt === "pending" ? "not-applicable" : state.receipt, reason: "cancel-requested" };
  if (state.deadlineReached) return { status: "failed", ok: false, exitCode: state.childExit.exitCode, signal: state.childExit.signal, taskContractStatus: state.receipt === "pending" ? "not-applicable" : state.receipt, reason: "deadline-reached" };
  if (state.runtimeError) return { status: "error", ok: false, exitCode: state.childExit.exitCode, signal: null, error: state.runtimeError, taskContractStatus: state.receipt, reason: "runtime-error" };

  // For receipt-requiring runs, defer finalization until receipt classification
  // is observed. This makes ChildExited -> ReceiptObserved deterministic.
  if (state.requireReceipt && state.receipt === "pending") return null;
  if (state.requireReceipt && state.receipt !== "verified") {
    return { status: state.childExit.exitCode === 0 ? "inconclusive" : "failed", ok: false, exitCode: state.childExit.exitCode, signal: state.childExit.signal, taskContractStatus: state.receipt, note: `Task contract ${state.receipt}; process exit is not accepted as task success.`, reason: `receipt-${state.receipt}` };
  }
  return { status: state.childExit.exitCode === 0 ? "done" : "failed", ok: state.childExit.exitCode === 0, exitCode: state.childExit.exitCode, signal: state.childExit.signal, taskContractStatus: state.receipt, taskResultSummary: state.receiptSummary, reason: state.receipt === "verified" ? "verified-receipt" : "process-exit" };
}

function assertState(state) {
  if (!state || state.version !== RUN_MACHINE_VERSION || !["running", "terminal"].includes(state.phase)) throw new Error("invalid run machine state");
}
function assertInput(input) {
  const valid = ["ChildExited", "ReceiptObserved", "CancelRequested", "DeadlineReached", "ProcessTerminated", "RuntimeError"];
  if (!input || !valid.includes(input.type)) throw new Error("invalid observed run input");
  if (input.type === "ChildExited" && !Number.isInteger(input.exitCode)) throw new Error("ChildExited requires integer exitCode");
  if (input.type === "ReceiptObserved" && !["verified", "missing", "mismatch", "malformed", "not-required"].includes(input.status)) throw new Error("invalid receipt status");
  if (input.type === "ReceiptObserved" && input.status === "verified" && input.summary !== undefined && (typeof input.summary !== "string" || input.summary.trim() === "")) throw new Error("verified receipt summary must be a non-empty string");
}
