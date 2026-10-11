const ACCOUNT_ID = process.env.PARALLEL_BENCH_ACCOUNT_ID ?? "";
const API_TOKEN = process.env.PARALLEL_BENCH_AI_TOKEN ?? "";

export default function (pi) {
  pi.registerProvider("bench-workers-ai", {
    name: "Workers AI (parallel bench, laptop lane)",
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`,
    apiKey: API_TOKEN,
    api: "openai-completions",
    models: [
      {
        id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        name: "Llama 3.3 70B (Workers AI)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
