import { Option, Schema } from "effect";

export const Usage = Schema.Struct({
  modelCalls: Schema.Int,
  promptTokens: Schema.Int,
  completionTokens: Schema.Int,
  estimatedUsd: Schema.Number,
  priceBasis: Schema.String,
});

export type Usage = typeof Usage.Type;

const INPUT_USD_PER_MILLION = 0.29;

const OUTPUT_USD_PER_MILLION = 2.25;

export const PRICE_BASIS = `workers-ai llama-3.3-70b-fp8-fast list price: $${INPUT_USD_PER_MILLION}/M in, $${OUTPUT_USD_PER_MILLION}/M out`;

export const ZERO_USAGE: Usage = { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedUsd: 0, priceBasis: PRICE_BASIS };

const ModelUsage = Schema.Struct({
  usage: Schema.Struct({ prompt_tokens: Schema.optional(Schema.Number), completion_tokens: Schema.optional(Schema.Number) }),
});

export interface CallTokens {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export const tokensOf = (output: ReturnType<typeof JSON.parse>): Option.Option<CallTokens> =>
  Schema.decodeUnknownOption(ModelUsage)(output).pipe(Option.map(({ usage }) => ({ promptTokens: Math.round(usage.prompt_tokens ?? 0), completionTokens: Math.round(usage.completion_tokens ?? 0) })));

const priced = (promptTokens: number, completionTokens: number) =>
  Math.round(((promptTokens * INPUT_USD_PER_MILLION + completionTokens * OUTPUT_USD_PER_MILLION) / 1_000_000) * 1_000_000) / 1_000_000;

export const addCall = (total: Usage, call: CallTokens): Usage => {
  const promptTokens = total.promptTokens + call.promptTokens;
  const completionTokens = total.completionTokens + call.completionTokens;

  return { modelCalls: total.modelCalls + 1, promptTokens, completionTokens, estimatedUsd: priced(promptTokens, completionTokens), priceBasis: PRICE_BASIS };
};

export const sumUsage = (items: ReadonlyArray<Usage>): Usage =>
  items.reduce((total, item) => {
    const promptTokens = total.promptTokens + item.promptTokens;
    const completionTokens = total.completionTokens + item.completionTokens;

    return { modelCalls: total.modelCalls + item.modelCalls, promptTokens, completionTokens, estimatedUsd: priced(promptTokens, completionTokens), priceBasis: PRICE_BASIS };
  }, ZERO_USAGE);
