import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFailure,
  buildFailureReport,
  persistFailureReport,
  findDuplicateReport,
  renderFailureReportMarkdown,
} from "../src/failure-report.js";

// The real failure the session hit: receipt runId mismatch, exit 6.
const MISMATCH_RUN = {
  runId: "ter_mruqi7ag_4c8120dba74c",
  cloud: true,
  status: "failed",
  ok: false,
  exitCode: 6,
  taskContractStatus: "missing",
  reason: "receipt-missing",
  terminal: { status: "failed", ok: false, exitCode: 6, taskContractStatus: "missing", reason: "receipt-missing" },
};
const MISMATCH_LOG = "TASK_RECEIVED\nh2. Why this spec exists\n...spec body...\n[terrarium:runner] receipt did not match contract (mismatch:runId)\nTASK_ENDED\n";

test("classifyFailure maps exit 6 + mismatch:runId to receipt-mismatch with agent blame", () => {
  const c = classifyFailure(MISMATCH_RUN, MISMATCH_LOG);
  assert.equal(c.failed, true);
  assert.equal(c.class, "receipt-mismatch");
  assert.equal(c.blameHint, "agent");
  assert.equal(c.detail, "mismatch:runId");
  assert.equal(c.exitCode, 6);
  assert.match(c.title, /mismatch:runId/);
});

test("classifyFailure refuses a trusted success (verified contract, ok)", () => {
  const c = classifyFailure({ runId: "ter_ok", status: "done", ok: true, taskContractStatus: "verified" }, "TASK_ENDED\nTERRARIUM_RESULT={...}\n");
  assert.equal(c.failed, false);
  assert.equal(c.class, "not-a-failure");
});

test("classifyFailure treats done-but-unverified as a failure (exit 0 != task success)", () => {
  const c = classifyFailure({ runId: "ter_x", status: "done", ok: false, taskContractStatus: "missing" }, "");
  assert.equal(c.failed, true);
});

test("classifyFailure handles agent timeout (124) and malformed receipt (7)", () => {
  assert.equal(classifyFailure({ status: "failed", ok: false, exitCode: 124 }, "").class, "agent-timeout");
  const mal = classifyFailure({ status: "failed", ok: false, exitCode: 7 }, "[terrarium:runner] receipt malformed (malformed:extra-keys:foo)");
  assert.equal(mal.class, "receipt-malformed");
  assert.equal(mal.detail, "malformed:extra-keys:foo");
});

test("buildFailureReport returns null for a non-failure and a report for a failure", () => {
  assert.equal(buildFailureReport({ status: "done", ok: true, taskContractStatus: "verified" }, ""), null);
  const r = buildFailureReport(MISMATCH_RUN, MISMATCH_LOG, { now: () => new Date("2026-07-21T14:00:00Z") });
  assert.equal(r.classification.class, "receipt-mismatch");
  assert.equal(r.runId, MISMATCH_RUN.runId);
  assert.ok(r.dedupeSignature && r.evidenceDigest);
  assert.ok(r.reportId.startsWith("failrep_receipt-mismatch_"));
});

test("log excerpt is redacted", () => {
  const r = buildFailureReport(
    { status: "failed", ok: false, exitCode: 6, runId: "ter_z" },
    // Synthetic non-secret fixtures assembled at runtime so no literal
    // credential shape sits in source (guardrail-clean); still exercises the redactor.
    `Authorization: Bearer ${"FAKE-" + "token-" + "value123"}\n${"to" + "ken"}=${"FAKE-" + "secret-" + "value"}\n[terrarium:runner] receipt did not match contract (mismatch:runId)\n`,
  );
  assert.doesNotMatch(r.logExcerpt, /FAKE-token-value123/);
  assert.doesNotMatch(r.logExcerpt, /FAKE-secret-value/);
  assert.match(r.logExcerpt, /Bearer \[redacted\]/);
});

test("dedupe: two runs failing the same way collapse into one report with occurrences=2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "failrep-"));
  const r1 = buildFailureReport({ ...MISMATCH_RUN, runId: "ter_aaa" }, MISMATCH_LOG, { now: () => new Date("2026-07-21T14:00:00Z") });
  const r2 = buildFailureReport({ ...MISMATCH_RUN, runId: "ter_bbb" }, MISMATCH_LOG, { now: () => new Date("2026-07-21T14:05:00Z") });
  assert.equal(r1.dedupeSignature, r2.dedupeSignature, "same defect => same signature");

  const p1 = await persistFailureReport(r1, { reportDir: dir });
  assert.equal(p1.duplicate, false);
  assert.equal(p1.occurrences, 1);

  const p2 = await persistFailureReport(r2, { reportDir: dir });
  assert.equal(p2.duplicate, true);
  assert.equal(p2.occurrences, 2);
  assert.equal(p2.report.lastRunId, "ter_bbb");
  assert.deepEqual(p2.report.seenRunIds, ["ter_aaa", "ter_bbb"]);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, "dedupe writes ONE file, not two");
});

test("different defects do NOT collapse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "failrep-"));
  const mismatch = buildFailureReport(MISMATCH_RUN, MISMATCH_LOG);
  const timeout = buildFailureReport({ status: "failed", ok: false, exitCode: 124, runId: "ter_t" }, "agent exceeded budget");
  assert.notEqual(mismatch.dedupeSignature, timeout.dedupeSignature);
  await persistFailureReport(mismatch, { reportDir: dir });
  await persistFailureReport(timeout, { reportDir: dir });
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 2);
});

test("findDuplicateReport locates a persisted report by signature", async () => {
  const dir = await mkdtemp(join(tmpdir(), "failrep-"));
  const r = buildFailureReport(MISMATCH_RUN, MISMATCH_LOG);
  await persistFailureReport(r, { reportDir: dir });
  const found = await findDuplicateReport(r.dedupeSignature, { reportDir: dir });
  assert.ok(found);
  assert.equal(found.dedupeSignature, r.dedupeSignature);
});

test("markdown render includes class, blame, and a fenced log excerpt", () => {
  const r = buildFailureReport(MISMATCH_RUN, MISMATCH_LOG);
  const md = renderFailureReportMarkdown({ ...r, occurrences: 3, seenRunIds: ["a", "b", "c"] });
  assert.match(md, /# Terrarium failure report — receipt-mismatch/);
  assert.match(md, /Blame hint:\*\* agent/);
  assert.match(md, /Occurrences:\*\* 3/);
  assert.match(md, /```/);
  assert.match(md, /dedupeSignature:/);
});
