import { Result, Schema } from "effect";

import type { ContractStatus, RunContract } from "./shared.ts";

const RECEIPT_PREFIX = "TERRARIUM_RESULT=";

const MAX_SUMMARY_BYTES = 2000;

const ReceiptJson = Schema.fromJsonString(Schema.Struct({
  nonce: Schema.String,
  summary: Schema.String,
  runId: Schema.optional(Schema.String),
  taskFingerprint: Schema.optional(Schema.String),
}));

const decodeReceipt = Schema.decodeUnknownResult(ReceiptJson, { onExcessProperty: "error" });

export interface ReceiptVerdict {
  readonly contractStatus: ContractStatus;
  readonly summary: string | null;
}

const rejected = (contractStatus: ContractStatus): ReceiptVerdict => ({ contractStatus, summary: null });

const echoMatches = (echoed: string | undefined, expected: string): boolean => echoed === undefined || echoed === expected;

const summaryFits = (summary: string): boolean => {
  const bytes = new TextEncoder().encode(summary).length;

  return bytes > 0 && bytes <= MAX_SUMMARY_BYTES && summary.trim().length > 0;
};

export const verifyReceipt = (output: string, contract: RunContract): ReceiptVerdict => {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith(RECEIPT_PREFIX));

  if (lines.length === 0) return rejected("missing");

  if (lines.length > 1) return rejected("malformed");

  return Result.match(decodeReceipt(lines[0].slice(RECEIPT_PREFIX.length)), {
    onFailure: () => rejected("malformed"),
    onSuccess: (receipt) => {
      if (receipt.nonce !== contract.nonce) return rejected("mismatch");

      if (!echoMatches(receipt.runId, contract.runId) || !echoMatches(receipt.taskFingerprint, contract.taskFingerprint)) return rejected("mismatch");

      if (!summaryFits(receipt.summary)) return rejected("malformed");

      return { contractStatus: "verified", summary: receipt.summary };
    },
  });
};
