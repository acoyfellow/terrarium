import test from "node:test";
import assert from "node:assert/strict";
import { isCloudRunId } from "../src/cloud-client.js";

// Regression for the bug report 2026-07-23: a local (cwd-scoped) background run
// returned by spawn was unreadable because read/status/cancel routed to cloud
// whenever cloudEnabled() was true — even for a local-shaped runId. The fix
// routes a by-id op by the runId's SHAPE (isCloudRunId), not by cloudEnabled().

test("local-shaped runIds are NOT cloud runIds (must route local)", () => {
  // The exact runIds from the bug report.
  for (const rid of [
    "ter_20260723231728312_psra35",
    "ter_20260723231733418_j1pujb",
    "ter_20260723231733418_k7pca3",
    "ter_20260723231733418_ashriw",
  ]) {
    assert.equal(isCloudRunId(rid), false, `${rid} must be recognized as LOCAL, not cloud`);
  }
});

test("cloud-shaped runIds ARE cloud runIds (route cloud)", () => {
  for (const rid of ["ter_mrw01ze_987bb8e54018", "ter_mruqi7ag_4c8120dba74c"]) {
    assert.equal(isCloudRunId(rid), true, `${rid} must be recognized as CLOUD`);
  }
});
