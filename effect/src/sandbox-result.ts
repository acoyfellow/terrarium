import type { ProofResult } from "./shared.ts";
import type { Usage } from "./usage.ts";

export interface SandboxResult {
  readonly output: string;
  readonly exitCode: number;
  readonly proof: ProofResult | null;
  readonly usage?: Usage;
}
