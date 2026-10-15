import type { ProofResult, RunContract } from "./shared.ts";
import type { Usage } from "./usage.ts";

export interface SandboxResult {
  readonly output: string;
  readonly exitCode: number;
  readonly proof: ProofResult | null;
  readonly usage?: Usage;
}

export interface SandboxJob {
  readonly task: string;
  readonly contract: RunContract;
  readonly proof: string | null;
}
