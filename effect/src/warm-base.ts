import { Schema } from "effect";

export const SETUP_HOSTS: ReadonlyArray<string> = ["registry.npmjs.org"];

export const SetupCommand = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(500));

export const BaseInfo = Schema.Struct({
  key: Schema.String,
  hit: Schema.Boolean,
  setupMs: Schema.NullOr(Schema.Int),
  setupExit: Schema.NullOr(Schema.Int),
});

export type BaseInfo = typeof BaseInfo.Type;

export const SETUP_TIMEOUT_MS = 300_000;

export const isSetupRequest = (request: Request): boolean => {
  const url = new URL(request.url);

  return (request.method === "GET" || request.method === "HEAD") && url.protocol === "https:" && SETUP_HOSTS.includes(url.hostname);
};

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const baseKey = (ownerId: string, github: string, ref: string, setup: string): Promise<string> =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([ownerId, github, ref, setup]))).then((digest) => `base:${hex(digest).slice(0, 32)}`);

export const SETUP_ENV = {
  NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  npm_config_cafile: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

export const commitSetupCommand = "cd /workspace && git -c user.name=terrarium -c user.email=terrarium@localhost add -A && git -c user.name=terrarium -c user.email=terrarium@localhost commit -q --allow-empty -m setup --no-verify && git rev-parse HEAD";

export const sessionFromBaseCommand = (branch: string) => `cd /workspace && git checkout -q base && git checkout -q -b ${branch} && git rev-parse HEAD`;
