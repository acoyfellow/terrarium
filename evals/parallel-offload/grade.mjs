import vm from "node:vm";
import { isDeepStrictEqual } from "node:util";

const FENCE = "`".repeat(3);
const CALL_TIMEOUT_MS = 500;

export function promptFor(task) {
  return [
    "Fix the bug in this JavaScript function.",
    `Specification: ${task.spec}`,
    "",
    FENCE + "js",
    task.buggy,
    FENCE,
    "",
    `Reply with only the corrected function named ${task.name} in one ${FENCE}js code block. No explanation.`,
  ].join("\n");
}

const HARNESS_LINE = /^(TASK_RECEIVED|TASK_ENDED|TERRARIUM_RESULT=.*|\[terrarium:[^\]]*\].*)$/;

export function stripHarnessLines(reply) {
  return String(reply ?? "").split("\n").filter((line) => !HARNESS_LINE.test(line.trim())).join("\n");
}

export function extractCode(reply) {
  const text = stripHarnessLines(reply);
  const fenced = [...text.matchAll(new RegExp(`${FENCE}(?:js|javascript)?\\s*\\n([\\s\\S]*?)${FENCE}`, "g"))].map((m) => m[1]);
  const withFunction = fenced.find((block) => /function\s+\w+|=>/.test(block));
  if (withFunction) return withFunction;
  const openFence = text.match(new RegExp(`${FENCE}(?:js|javascript)?\\s*\\n([\\s\\S]*)$`));
  if (openFence && /function\s+\w+|=>/.test(openFence[1])) return openFence[1];
  const start = text.search(/function\s+\w+\s*\(/);
  return start >= 0 ? text.slice(start) : "";
}

export function gradeReply(task, reply) {
  const code = extractCode(reply);
  if (!code.trim()) return { pass: false, reason: "no-code" };
  for (const [args, expected] of task.cases) {
    let actual;
    try {
      const context = vm.createContext({ input: structuredClone(args) });
      vm.runInContext(`${code}\n;globalThis.output = ${task.name}(...input);`, context, { timeout: CALL_TIMEOUT_MS });
      actual = JSON.parse(JSON.stringify(context.output ?? null));
    } catch (error) {
      return { pass: false, reason: `error: ${String(error?.message ?? error).slice(0, 120)}` };
    }
    if (!isDeepStrictEqual(actual, JSON.parse(JSON.stringify(expected)))) {
      return { pass: false, reason: `case ${JSON.stringify(args)} returned ${JSON.stringify(actual)}` };
    }
  }
  return { pass: true, reason: "all-cases" };
}

export function gradeBuggySelfCheck(task) {
  return gradeReply(task, `${FENCE}js\n${task.buggy}\n${FENCE}`);
}
