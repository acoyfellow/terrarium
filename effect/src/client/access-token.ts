import { execFile } from "node:child_process";

import { Effect, Layer } from "effect";

import { Unauthorized } from "../shared.ts";
import { TokenSource } from "./http.ts";

const cloudflared = (args: ReadonlyArray<string>) =>
  Effect.callback<string, Unauthorized>((resume) => {
    execFile("cloudflared", [...args], (error, stdout, stderr) =>
      resume(error === null ? Effect.succeed(stdout.trim()) : Effect.fail(new Unauthorized({ reason: `cloudflared ${args[0]} ${args[1]}: ${stderr.trim() || error.message}` }))));
  });

export const accessToken = (url: string) =>
  cloudflared(["access", "token", `-app=${url}`]).pipe(
    Effect.filterOrFail((token) => token.length > 0, () => new Unauthorized({ reason: `no Access token for ${url}; run terra-effect login ${url}` })),
  );

export const login = (url: string) => cloudflared(["access", "login", url]);

export const TokenSourceLive = (url: string, bearer: string | undefined) =>
  Layer.succeed(TokenSource, TokenSource.of({
    header: bearer === undefined || bearer.length === 0
      ? Effect.map(accessToken(url), (value) => ({ name: "cf-access-token", value }))
      : Effect.succeed({ name: "authorization", value: `Bearer ${bearer}` }),
  }));
