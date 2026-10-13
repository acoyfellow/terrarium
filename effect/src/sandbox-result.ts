import type { ProofResult } from "./shared.ts";

export interface SandboxResult {
  readonly output: string;
  readonly exitCode: number;
  readonly proof: ProofResult | null;
}
