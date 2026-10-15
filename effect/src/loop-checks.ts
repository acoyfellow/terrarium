import { Schema } from "effect";

const text = (maxLength: number) => Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));

export const NamedCheck = Schema.Struct({ name: text(80), command: text(1000) });

export type NamedCheck = typeof NamedCheck.Type;

export const NamedChecks = Schema.Array(NamedCheck).check(Schema.isMinLength(1), Schema.isMaxLength(8));

export const CheckState = Schema.Literals(["passed", "failed", "not-run"]);

export type CheckState = typeof CheckState.Type;

export const CheckResult = Schema.Struct({ name: Schema.String, state: CheckState });

export type CheckResult = typeof CheckResult.Type;

const MARKER = "TERRARIUM_CHECK";

const quoted = (command: string) => `'${command.replaceAll("'", "'\\''")}'`;

export const checksCommand = (checks: ReadonlyArray<NamedCheck>, proof: string | undefined): string => {
  const commands = [...(proof === undefined ? [] : [proof]), ...checks.map((check) => check.command)];
  const runs = commands.map((command, index) => `sh -c ${quoted(command)} > /tmp/terrarium-check-${index}.log 2>&1; c${index}=$?`);
  const tails = commands.map((_, index) => `tail -c 300 /tmp/terrarium-check-${index}.log`);
  const marks = commands.map((_, index) => `echo "${MARKER} ${index} $c${index}"`);
  const verdict = `[ ${commands.map((_, index) => `"$c${index}" = 0`).join(" ] && [ ")} ]`;

  return [...runs, ...tails, ...marks, verdict].join("; ");
};

const markerLine = /^TERRARIUM_CHECK (\d+) (\d+)$/;

export const checkResults = (checks: ReadonlyArray<NamedCheck>, proof: string | undefined, output: string | null): ReadonlyArray<CheckResult> => {
  const offset = proof === undefined ? 0 : 1;

  const exits = new Map((output ?? "").split("\n").flatMap((line) => {
    const match = markerLine.exec(line.trim());

    return match === null ? [] : [[Number(match[1]), Number(match[2])] as const];
  }));

  return checks.map((check, index) => {
    const exit = exits.get(index + offset);

    if (exit === undefined) return { name: check.name, state: "not-run" };

    return { name: check.name, state: exit === 0 ? "passed" : "failed" };
  });
};

const symbol: Record<CheckState, string> = { passed: "✓", failed: "✗", "not-run": "○" };

export const scoreLine = (results: ReadonlyArray<CheckResult>): string => {
  const count = (state: CheckState) => results.filter((result) => result.state === state).length;

  return (["passed", "not-run", "failed"] as const).map((state) => `${count(state)}${symbol[state]}`).join(" ");
};
