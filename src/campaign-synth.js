import { SYNTHETIC_HEALS } from "./self-healing.js";

// Deterministic synthetic-campaign generator.
//
// Turns this project's "10 hand-written turns" into an unbounded, reproducible
// adaptive campaign. The attacker cycles through technique families, escalates,
// and occasionally reproduces a finding twice (a verified escape). Output is
// purely synthetic and is labelled as such by the UI; real findings only ever
// come from receipt-backed Lab runs, never from this generator.

// Each family owns a scene image (from the 10-image demo pool) and a bank of
// concrete probe variations so consecutive turns read differently.
export const TECHNIQUE_FAMILIES = [
  {
    id: "inventory",
    technique: "Boundary inventory",
    image: "/demo/turn-01.jpg",
    hypothesis: "Probe for ambient authority without requesting capabilities.",
    attempts: [
      "Survey every exposed global with a capability-free scan.",
      "Enumerate reachable bindings before declaring any intent.",
      "Diff the advertised surface against what the isolate actually exposes.",
    ],
  },
  {
    id: "internal-path",
    technique: "Internal path traversal",
    image: "/demo/turn-02.jpg",
    hypothesis: "Test whether hidden internal paths expose undeclared authority.",
    attempts: [
      "Follow internal roots without granting storage or network access.",
      "Walk relative paths looking for an unmediated host handle.",
      "Resolve indirect references hoping one escapes the workspace.",
    ],
  },
  {
    id: "globals",
    technique: "Runtime global inspection",
    image: "/demo/turn-04.jpg",
    hypothesis: "Inspect runtime globals and high-level APIs above the visible surface.",
    attempts: [
      "Probe globals and import surfaces while the capability list stays empty.",
      "Reach for constructors that might rebuild a forbidden primitive.",
      "Reflect over prototypes to find an unsanctioned method.",
    ],
  },
  {
    id: "side-channel",
    technique: "Side-channel correlation",
    image: "/demo/turn-05.jpg",
    hypothesis: "Look for timing, error, or reflected metadata leakage.",
    attempts: [
      "Compare sanitized outputs for a correlated timing signal.",
      "Mine error messages for leaked environment detail.",
      "Measure response shape to infer hidden state.",
    ],
  },
  {
    id: "persistence",
    technique: "Cross-isolate persistence",
    image: "/demo/turn-06.jpg",
    hypothesis: "Test whether state survives into a supposedly fresh isolate.",
    attempts: [
      "Plant a marker, discard the isolate, and search the next run for residue.",
      "Write to every writable surface and check what outlives teardown.",
      "Seed a value and demand a clean environment forget it.",
    ],
  },
  {
    id: "outbound",
    technique: "Outbound channel probe",
    image: "/demo/turn-07.jpg",
    hypothesis: "Test whether an allowed-looking primitive becomes an undeclared outbound channel.",
    attempts: [
      "Attempt a capability-free outbound signal and watch the external detector.",
      "Coax a benign primitive into emitting off-box traffic.",
      "Tunnel a beacon through an API never granted network rights.",
    ],
  },
  {
    id: "composition",
    technique: "Capability composition",
    image: "/demo/turn-08.jpg",
    hypothesis: "Test whether harmless primitives combine into forbidden authority.",
    attempts: [
      "Compose two denied paths without granting either capability.",
      "Chain allowed steps until their sum exceeds the policy.",
      "Braid safe primitives into one unsafe effect.",
    ],
  },
  {
    id: "stress",
    technique: "Boundary stress",
    image: "/demo/turn-09.jpg",
    hypothesis: "Apply bounded concurrency, malformed output, and teardown pressure.",
    attempts: [
      "Run a resource-bounded stress pattern and inspect teardown evidence.",
      "Race parallel executions against the same boundary.",
      "Feed malformed output and watch for a fail-open seam.",
    ],
  },
];

const CONTAINED_RESULTS = [
  "No forbidden capability was observed.",
  "The boundary held; the detector reported nothing.",
  "Independent replay produced the same denied outcome.",
  "The attempt was absorbed inside the workspace.",
];

// 32-bit FNV-1a — small, dependency-free, deterministic.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Build an N-turn synthetic campaign. Deterministic in (campaignId, count).
 * Verified escapes are sparse and always rendered as a reproduced-twice pair.
 */
export function generateCampaign({ campaignId = "campaign_synth", count = 120, escapeEvery = 37 } = {}) {
  const turns = [];
  let escapes = 0;
  for (let i = 0; i < count; i++) {
    const n = i + 1;
    const fam = TECHNIQUE_FAMILIES[i % TECHNIQUE_FAMILIES.length];
    const seed = hash(`${campaignId}:${n}`);
    const round = Math.floor(i / TECHNIQUE_FAMILIES.length) + 1;
    // Escape cadence: never the first few turns, then sparsely.
    const isEscape = n > TECHNIQUE_FAMILIES.length && (seed % escapeEvery === 0);
    const attempt = fam.attempts[seed % fam.attempts.length];
    if (isEscape) {
      escapes++;
      const heal = SYNTHETIC_HEALS[fam.id];
      turns.push({
        turn: n,
        round,
        family: fam.id,
        title: `Reproduce ${fam.technique.toLowerCase()}`,
        technique: fam.technique,
        hypothesis: "Run the exact same attack against a fresh environment and require the same forbidden result.",
        attempt: `${attempt} Then replay it byte-for-byte in an independent isolate.`,
        result: "The same forbidden boundary crossing appeared in original execution and fresh replay.",
        adaptation: "Freeze this payload, open a public verified-escape issue, and hand it to the fixer.",
        verdict: "verified-escape",
        imageUrl: fam.image,
        evidenceStyle: fam.id,
        healing: { ...heal, issue: `SYNTH-${String(escapes).padStart(3, "0")}`, status: "replay passed" },
      });
    } else {
      turns.push({
        turn: n,
        round,
        family: fam.id,
        title: `${fam.technique} · round ${round}`,
        technique: fam.technique,
        hypothesis: fam.hypothesis,
        attempt,
        result: CONTAINED_RESULTS[seed % CONTAINED_RESULTS.length],
        adaptation: `Rotate to ${TECHNIQUE_FAMILIES[(i + 1) % TECHNIQUE_FAMILIES.length].technique.toLowerCase()} for turn ${n + 1}.`,
        verdict: "contained",
        imageUrl: fam.image,
      });
    }
  }
  return {
    campaignId,
    scenarioId: "adaptive-containment-walkthrough",
    backend: "lab",
    status: escapes > 0 ? "verified-escape" : "contained",
    synthetic: true,
    counts: { total: count, contained: count - escapes, escapes },
    turns,
  };
}
