// Terrarium credentialless model provider for the Pi execution cell.
//
// This extension registers exactly one provider ("terrarium") pointing Pi at
// the intercepted server-owned model route. The cell holds NO reusable model
// credential: the outbound fetch to TERRARIUM_MODEL_BASE_URL is intercepted by
// the exact-host ContainerProxy handler in the Worker, which attaches Workers
// AI authority server-side. The apiKey here is a nonsecret placeholder solely
// because the OpenAI-completions client requires the field to be present.
//
// Boundary-interception precedent: the Cloudflare runtime already injects
// authority at the network boundary (globalOutbound) so guest code never holds
// a credential. This applies that same pattern to Workers AI.
//
// The base URL is read from the environment so a fixed localhost qualification
// endpoint and the production intercepted route share one code path.

const BASE_URL = process.env.TERRARIUM_MODEL_BASE_URL || "https://terrarium.coey.dev/_terrarium_model/v1";

export default function (pi) {
  pi.registerProvider("terrarium", {
    name: "Terrarium Workers AI (credentialless cell)",
    baseUrl: BASE_URL,
    apiKey: "terrarium-nonsecret-placeholder",
    api: "openai-completions",
    models: [
      {
        id: "workers-ai",
        name: "Terrarium Workers AI",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
