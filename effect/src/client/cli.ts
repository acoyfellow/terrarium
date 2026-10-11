import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Option, Schema } from "effect";

import { login } from "./access-token.ts";
import { TerrariumClient } from "./http.ts";
import { clientLayer, serveStdio } from "./mcp.ts";

const CONFIG_PATH = join(homedir(), ".terrarium", "effect-config.json");

const PI_DIR = join(homedir(), ".pi", "agent");

const MCP_PATH = join(PI_DIR, "mcp.json");

const EXTENSION_LINK = join(PI_DIR, "extensions", "terrarium");

const McpFile = Schema.fromJsonString(Schema.Struct({ mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Json)) }));

export const withTerrariumServer = (raw: string, url: string, mcpEntry: string) => {
  const current = Schema.decodeUnknownOption(McpFile)(raw).pipe(Option.getOrElse(() => ({ mcpServers: {} })));
  const terrarium = { command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", mcpEntry], env: { TERRARIUM_URL: url } };

  return `${JSON.stringify({ ...current, mcpServers: { ...current.mcpServers, terrarium } }, null, 2)}\n`;
};

const connectPi = (url: string) => Effect.sync(() => {
  const mcpEntry = fileURLToPath(new URL("./mcp.ts", import.meta.url));
  const extension = fileURLToPath(new URL("../../pi-extension", import.meta.url));

  mkdirSync(dirname(EXTENSION_LINK), { recursive: true });
  writeFileSync(MCP_PATH, withTerrariumServer(readFileSync(MCP_PATH, { encoding: "utf8", flag: "a+" }), url, mcpEntry));
  rmSync(EXTENSION_LINK, { force: true, recursive: false });
  symlinkSync(extension, EXTENSION_LINK);
});

const Config = Schema.fromJsonString(Schema.Struct({ cloudUrl: Schema.String, accessLogin: Schema.Boolean }));

const configuredUrl = () => process.env.TERRARIUM_URL ?? Schema.decodeUnknownOption(Config)(readFileSync(CONFIG_PATH, { encoding: "utf8", flag: "a+" })).pipe(Option.match({ onNone: () => "", onSome: (config) => config.cloudUrl }));

const whoami = (url: string) => Effect.flatMap(TerrariumClient, (client) => client.whoami).pipe(Effect.provide(clientLayer(url)));

const printWho = (who: { readonly owner: string; readonly method: string }) => Effect.sync(() => console.log(`Signed in as ${who.owner} (${who.method}). Reload Pi.`));

const signIn = (url: string) => Effect.gen(function* () {
  yield* login(url);
  const who = yield* whoami(url);

  yield* Effect.sync(() => {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify({ cloudUrl: url, accessLogin: true }, null, 2)}\n`);
  });
  yield* connectPi(url);
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

if (import.meta.main) Effect.runPromise(main(process.argv.slice(2))).catch((error: Error) => {
  console.error(String(error));
  process.exitCode = 1;
});
