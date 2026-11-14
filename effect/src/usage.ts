import { Option, Schema } from "effect";

import { DEFAULT_MODEL, priceBasisOf, priceOf } from "./models.ts";

export const Usage = Schema.Struct({
  modelCalls: Schema.Int,
  promptTokens: Schema.Int,
  completionTokens: Schema.Int,
  estimatedUsd: Schema.Number,
  priceBasis: Schema.String,
});

export type Usage = typeof Usage.Type;

export const PRICE_BASIS = priceBasisOf(DEFAULT_MODEL);

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

const roundUsd = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

const priced = (promptTokens: number, completionTokens: number, model: string) =>
  Option.match(priceOf(model), {
    onNone: () => 0,
    onSome: (price) => roundUsd((promptTokens * price.inPerMillion + completionTokens * price.outPerMillion) / 1_000_000),
  });

// One box runs one model, so a run's total is priced from its token totals.
export const addCall = (total: Usage, call: CallTokens, model: string = DEFAULT_MODEL): Usage => {
  const promptTokens = total.promptTokens + call.promptTokens;
  const completionTokens = total.completionTokens + call.completionTokens;

  return { modelCalls: total.modelCalls + 1, promptTokens, completionTokens, estimatedUsd: priced(promptTokens, completionTokens, model), priceBasis: priceBasisOf(model) };
};

// Attempts of a loop can use different models, so each keeps its own price and the bases are listed.
export const sumUsage = (items: ReadonlyArray<Usage>): Usage => {
  const bases = [...new Set(items.map((item) => item.priceBasis))];

  return items.reduce((total, item) => ({
    modelCalls: total.modelCalls + item.modelCalls,
    promptTokens: total.promptTokens + item.promptTokens,
    completionTokens: total.completionTokens + item.completionTokens,
    estimatedUsd: roundUsd(total.estimatedUsd + item.estimatedUsd),
    priceBasis: bases.length === 0 ? PRICE_BASIS : bases.join(" + "),
  }), ZERO_USAGE);
};
