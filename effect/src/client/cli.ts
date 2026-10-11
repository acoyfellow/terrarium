import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Option, Schema } from "effect";

import { login } from "./access-token.ts";
import { TerrariumClient } from "./http.ts";
import { clientLayer, serveStdio } from "./mcp.ts";

const CONFIG_PATH = join(homedir(), ".terrarium", "effect-config.json");

const Config = Schema.fromJsonString(Schema.Struct({ cloudUrl: Schema.String, accessLogin: Schema.Boolean }));

const configuredUrl = () => process.env.TERRARIUM_URL ?? Schema.decodeUnknownOption(Config)(readFileSync(CONFIG_PATH, { encoding: "utf8", flag: "a+" })).pipe(Option.match({ onNone: () => "", onSome: (config) => config.cloudUrl }));

const whoami = (url: string) => Effect.flatMap(TerrariumClient, (client) => client.whoami).pipe(Effect.provide(clientLayer(url)));

const printWho = (who: { readonly owner: string; readonly method: string }) => Effect.sync(() => console.log(`${who.owner} (${who.method})`));

const signIn = (url: string) => Effect.gen(function* () {
  yield* login(url);
  const who = yield* whoami(url);

  yield* Effect.sync(() => {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify({ cloudUrl: url, accessLogin: true }, null, 2)}\n`);
  });
  yield* printWho(who);
});

const usage = Effect.sync(() => console.error("usage: terra-effect login <url> | whoami | mcp"));

const main = (args: ReadonlyArray<string>) => {
  const [command, url] = args;

  if (command === "login" && url !== undefined) return signIn(url);

  if (command === "whoami") return Effect.flatMap(whoami(configuredUrl()), printWho);

  if (command === "mcp") return Effect.sync(() => serveStdio(configuredUrl()));

  return usage.pipe(Effect.andThen(Effect.sync(() => { process.exitCode = 2; })));
};

Effect.runPromise(main(process.argv.slice(2))).catch((error: Error) => {
  console.error(String(error));
  process.exitCode = 1;
});
