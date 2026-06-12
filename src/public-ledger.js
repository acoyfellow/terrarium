function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export const EMPTY_PUBLIC_CAMPAIGN = {
  campaignId: "terrarium-live",
  scenarioId: "terrarium-self-hardening",
  backend: "lab",
  status: "waiting",
  synthetic: false,
  counts: { total: 0, contained: 0, escapes: 0 },
  turns: [],
};

// Public records deliberately exclude payload bodies, raw detector output,
// credentials, and private artifact keys. The private R2 receipt remains the
// source of truth for responsible disclosure and replay.
export function publicTurnFromReceipt(receipt, { hypothesis, sourceRevision, healing } = {}) {
  if (!receipt || receipt.fixture) throw new Error("public ledger accepts real receipts only");
  const verdict = receipt.verifiedVerdict || receipt.verdict || "inconclusive";
  return {
    turn: 0,
    campaignId: receipt.campaignId,
    scenarioId: receipt.scenarioId,
    backend: receipt.backend,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    sourceRevision: safeText(sourceRevision, "unknown"),
    title: verdict === "verified-escape" ? "Independently verified boundary crossing" : "Boundary held",
    technique: safeText(receipt.scenarioId, "hostile probe"),
    hypothesis: safeText(hypothesis, "Bounded adversarial probe"),
    attempt: `Executed redacted payload sha256:${receipt.payloadHash} in a fresh Lab environment.`,
    result: safeText(receipt.observed, verdict),
    adaptation: verdict === "verified-escape" ? "Evidence quarantined; publish a redacted issue and start the autonomous repair loop." : "Use sanitized feedback to propose the next bounded attack.",
    verdict,
    payloadHash: receipt.payloadHash,
    evidence: {
      executionId: receipt.execution?.resultId || null,
      replayId: receipt.replay?.resultId || null,
      independentReplay: Boolean(receipt.replay),
    },
    healing: healing || null,
  };
}

export function appendPublicTurn(campaign, turn) {
  const current = campaign?.synthetic === false ? campaign : EMPTY_PUBLIC_CAMPAIGN;
  const turns = [...current.turns, { ...turn, turn: current.turns.length + 1 }];
  const escapes = turns.filter((item) => item.verdict === "verified-escape").length;
  return {
    ...current,
    status: turn.healing?.status === "merged" ? "healed" : turn.verdict,
    counts: { total: turns.length, contained: turns.length - escapes, escapes },
    turns,
  };
}
