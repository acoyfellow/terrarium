import assert from "node:assert/strict";
import test from "node:test";

import { afterApproval, rejectedTask } from "../src/approval.ts";

test("approve stops the loop as passed", () => {
  assert.deepEqual(afterApproval({ verdict: "approve", by: "j@x" }, 1, 3), { action: "stop", outcome: "passed", reason: "attempt 1 passed its gate and was approved by j@x" });
});

test("reject retries with the note while attempts remain", () => {
  assert.deepEqual(afterApproval({ verdict: "reject", by: "j@x", note: "use tabs" }, 1, 3), { action: "retry", note: "use tabs" });
  assert.equal(afterApproval({ verdict: "reject", by: "j@x" }, 3, 3).action, "stop");
});

test("no answer in time stops as exhausted", () => {
  const next = afterApproval(null, 2, 3);

  assert.equal(next.action === "stop" && next.outcome, "exhausted");
});

test("the retry task carries the owner's note", () => {
  assert.match(rejectedTask("do x", 2, "use tabs"), new RegExp("rejected it: use tabs$"));
});
