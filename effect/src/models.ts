import { Option } from "effect";

// One run, one model. The box never names or holds a model: the Worker
// records the run's model on the box's Durable Object before the agent starts,
// and the model route reads it from there. A box that edits its own requests
// cannot pick a different model, because the request's `model` field is ignored.

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const MAX_MODEL_LENGTH = 120;

export type ModelRoute =
  | { readonly kind: "workers-ai"; readonly id: string }
  | { readonly kind: "gateway"; readonly id: string };

// Workers AI catalog ids: @cf/<vendor>/<model> or @hf/<vendor>/<model>.
const WORKERS_AI = /^@(cf|hf)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

// AI Gateway unified API ids: <provider>/<model>, for example anthropic/claude-haiku-4-5.
const GATEWAY = /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/;

export const routeOf = (model: string): Option.Option<ModelRoute> => {
  if (model.length > MAX_MODEL_LENGTH) return Option.none();

  if (WORKERS_AI.test(model)) return Option.some({ kind: "workers-ai", id: model });

  if (GATEWAY.test(model)) return Option.some({ kind: "gateway", id: model });

  return Option.none();
};

export const modelProblems = (model: string | null | undefined): ReadonlyArray<string> => {
  if (model === null || model === undefined) return [];

  return Option.isSome(routeOf(model)) ? [] : [`model must be a Workers AI id (@cf/<vendor>/<model>) or an AI Gateway id (<provider>/<model>), at most ${MAX_MODEL_LENGTH} characters`];
};

export interface Price {
  readonly inPerMillion: number;
  readonly outPerMillion: number;
}

// List prices in USD per million tokens. A model missing here still runs;
// its receipt says it has no list price instead of guessing one.
export const PRICES: ReadonlyMap<string, Price> = new Map([
  [DEFAULT_MODEL, { inPerMillion: 0.29, outPerMillion: 2.25 }],
  ["anthropic/claude-haiku-4-5", { inPerMillion: 1, outPerMillion: 5 }],
  ["anthropic/claude-sonnet-4-5", { inPerMillion: 3, outPerMillion: 15 }],
]);

export const priceOf = (model: string): Option.Option<Price> => Option.fromNullishOr(PRICES.get(model));

const LEGACY_BASIS = "workers-ai llama-3.3-70b-fp8-fast";

export const priceBasisOf = (model: string): string =>
  Option.match(priceOf(model), {
    onNone: () => `${model}: no list price recorded; estimatedUsd counts it as 0`,
    onSome: (price) => `${model === DEFAULT_MODEL ? LEGACY_BASIS : model} list price: $${price.inPerMillion}/M in, $${price.outPerMillion}/M out`,
  });
