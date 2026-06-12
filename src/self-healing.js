// Synthetic walkthrough records for the public demo. These are explicitly not
// real findings. Each record tells the complete improve-Terrarium loop and links
// to the actual product surface the lesson would harden.
export const SYNTHETIC_HEALS = {
  inventory: {
    boundary: "ambient authority",
    lesson: "The capability contract must be machine-checkable, not implied by the prompt.",
    change: "Reject undeclared globals before guest code executes.",
    test: "ambient authority remains absent in a fresh Lab isolate",
    sourceUrl: "https://github.com/acoyfellow/terrarium/blob/main/src/lab.js",
    testUrl: "https://github.com/acoyfellow/terrarium/blob/main/test/lab.test.js",
  },
  "internal-path": {
    boundary: "workspace filesystem",
    lesson: "Workspace separation must be verified from outside the attacker process.",
    change: "Add a trusted detector for reads and writes beyond the declared workspace.",
    test: "path traversal cannot cross the workspace boundary",
    sourceUrl: "https://github.com/acoyfellow/terrarium/blob/main/src/sandbox.js",
    testUrl: "https://github.com/acoyfellow/terrarium/blob/main/test/sandbox.test.js",
  },
  globals: {
    boundary: "runtime capability surface",
    lesson: "High-level runtime APIs can reconstruct authority even when direct bindings are absent.",
    change: "Validate the complete Lab payload and reject forbidden runtime surfaces.",
    test: "forbidden payload primitives fail closed",
    sourceUrl: "https://github.com/acoyfellow/terrarium/blob/main/src/lab.js",
    testUrl: "https://github.com/acoyfellow/terrarium/blob/main/test/lab.test.js",
  },
  "side-channel": {
    boundary: "sanitized attacker feedback",
    lesson: "Raw detector output can teach the attacker secrets it did not earn.",
    change: "Sanitize every turn receipt before it becomes the next attacker prompt.",
    test: "adaptive feedback excludes raw evidence and secrets",
    sourceUrl: "https://github.com/acoyfellow/terrarium/blob/main/src/adaptive.js",
    testUrl: "https://github.com/acoyfellow/terrarium/blob/main/test/adaptive.test.js",
  },
  persistence: {
    boundary: "fresh-environment guarantee",
    lesson: "A replay is independent only when state cannot survive teardown.",
    change: "Require a fresh execution environment and compare independent receipts.",
    test: "verified escape requires a fresh replay",
    sourceUrl: "https://github.com/acoyfellow/terrarium/blob/main/src/hostile.js",
    testUrl: "https://github.com/acoyfellow/terrarium/blob/main/test/hostile.test.js",
  },
  outbound: {
    boundary: "network capability",
    lesson: "The attacker cannot be trusted to report whether an outbound signal escaped.",
    change: "Move network verdicts into a scenario-owned external detector.",
    test: "network-disabled probe stays contained",
    sourceUrl: "https://github.com/acoyfellow/terrarium/blob/main/src/sandbox.js",
    testUrl: "https://github.com/acoyfellow/terrarium/blob/main/test/sandbox.test.js",
  },
  composition: {
    boundary: "declared capability policy",
    lesson: "Individually safe primitives can compose into forbidden authority.",
    change: "Replay the exact composed payload under the patched policy before merge.",
    test: "replay gate rejects any reproduced violation",
    sourceUrl: "https://github.com/acoyfellow/terrarium/blob/main/src/control-worker.js",
    testUrl: "https://github.com/acoyfellow/terrarium/blob/main/test/control-worker.test.js",
  },
  stress: {
    boundary: "runtime and teardown budget",
    lesson: "Containment must fail closed under concurrency and resource pressure.",
    change: "Keep hostile runs bounded and require deterministic teardown evidence.",
    test: "bounded hostile scenario cannot outlive its run",
    sourceUrl: "https://github.com/acoyfellow/terrarium/blob/main/src/hostile.js",
    testUrl: "https://github.com/acoyfellow/terrarium/blob/main/test/hostile.test.js",
  },
};
