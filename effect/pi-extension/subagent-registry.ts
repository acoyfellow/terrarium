import { REGISTRY_KEY, providerFor } from "./subagent-provider.ts";

type Provider = ReturnType<typeof providerFor>;

interface Registry {
  readonly version: 1;
  readonly providers: Map<string, Provider>;
}

export const REGISTRY: unique symbol = Symbol.for(REGISTRY_KEY);

export interface RegistryHost {
  [REGISTRY]?: Registry;
  readonly globalThis?: object;
}

const globalHost: RegistryHost = globalThis;

export const registerProvider = (url: string, host: RegistryHost = globalHost) => {
  const provider = providerFor(url);
  const found = host[REGISTRY];
  const registry: Registry = found?.version === 1 && found.providers instanceof Map ? found : { version: 1, providers: new Map() };

  host[REGISTRY] = registry;
  registry.providers.set(provider.name, provider);

  return provider;
};
