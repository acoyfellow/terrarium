export interface TimingInput {
  readonly startMs: number;
  readonly boxReadyMs: number;
  readonly endMs: number;
  readonly runnerOutput: string;
}

const stampOf = (output: string, name: string) => Number(output.match(new RegExp(`${name}=(\\d+)`))?.[1] ?? Number.NaN);

export const timingLine = (input: TimingInput) => {
  const runnerStart = stampOf(input.runnerOutput, "runner_start_ms");
  const agentEnd = stampOf(input.runnerOutput, "agent_end_ms");
  const phases = { box_ms: input.boxReadyMs - input.startMs, runner_wait_ms: runnerStart - input.boxReadyMs, agent_ms: agentEnd - runnerStart, tail_ms: input.endMs - agentEnd, total_ms: input.endMs - input.startMs };

  return `TERRARIUM_PHASES ${Object.entries(phases).filter(([, value]) => Number.isFinite(value)).map(([key, value]) => `${key}=${value}`).join(" ")}`;
};
