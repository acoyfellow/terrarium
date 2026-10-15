import { verifyReceipt } from "./receipt.ts";
import type { SandboxResult } from "./sandbox-result.ts";
import type { RunContract, RunTerminal, Upstream } from "./shared.ts";

export interface Outcome {
  readonly terminal: RunTerminal;
  readonly logs: string;
}

const proofPassed = (result: SandboxResult): boolean => result.proof === null || result.proof.exitCode === 0;

export const terminalOf = (result: SandboxResult, contract: RunContract, finishedAt: string): Outcome => {
  const verdict = verifyReceipt(result.output, contract);
  const done = result.exitCode === 0 && verdict.provenance === "this-run" && proofPassed(result);

  const terminal: RunTerminal = { status: done ? "done" : "failed", provenance: verdict.provenance, proof: result.proof, summary: verdict.summary, exitCode: result.exitCode, finishedAt };

  return { terminal: result.usage === undefined ? terminal : { ...terminal, usage: result.usage }, logs: result.output };
};

export const failedOutcome = (error: Upstream, finishedAt: string): Outcome => ({
  terminal: { status: "failed", provenance: "missing", summary: null, exitCode: null, finishedAt },
  logs: `${error.service}: ${error.detail}`,
});


export const refusedRestart = (attempts: number, finishedAt: string): Outcome => ({
  terminal: { status: "failed", provenance: "missing", summary: null, exitCode: null, finishedAt },
  logs: `terrarium: this run's agent already started once; start attempt ${attempts} was refused so the agent never runs twice`,
});
