import type { ProofResult, RunContract, WorkspaceSnapshot } from "./shared.ts";
import type { RepoResult, RepoSpec } from "./repo.ts";
import type { Usage } from "./usage.ts";

export interface SandboxResult {
  readonly output: string;
  readonly exitCode: number;
  readonly proof: ProofResult | null;
  readonly usage?: Usage;
  readonly workspace?: WorkspaceSnapshot | null;
  readonly restored?: boolean;
  readonly repo?: RepoResult | null;
}

export interface SandboxJob {
  readonly task: string;
  readonly contract: RunContract;
  readonly proof: string | null;
  readonly resume?: WorkspaceSnapshot | null;
  readonly repo?: RepoSpec | null;
  readonly ownerId?: string;
}
