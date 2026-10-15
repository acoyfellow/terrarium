import { Schema } from "effect";

export const MAX_PLUGINS = 4;

export const MAX_PLUGIN_BYTES = 20_000;

export const PLUGIN_DIR = "/tmp/terrarium-plugins";

export const Plugin = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(new RegExp("^[a-z][a-z0-9-]{0,39}$"))),
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PLUGIN_BYTES)),
  tools: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isPattern(new RegExp("^[a-z][a-z0-9_]{0,39}$")))).check(Schema.isMaxLength(8))),
});

export type Plugin = typeof Plugin.Type;

export const Plugins = Schema.Array(Plugin).check(Schema.isMaxLength(MAX_PLUGINS));

export const pluginProblems = (plugins: ReadonlyArray<Plugin>): ReadonlyArray<string> => {
  const names = plugins.map((plugin) => plugin.name);

  return new Set(names).size === names.length ? [] : ["plugin names must be unique"];
};

export const pluginPath = (plugin: Plugin) => `${PLUGIN_DIR}/${plugin.name}.ts`;

export const pluginEnv = (plugins: ReadonlyArray<Plugin>): string => plugins.map(pluginPath).join(":");

export const BASE_TOOLS = ["read", "write", "edit", "bash"];

export const agentTools = (plugins: ReadonlyArray<Plugin>): string => [...new Set([...BASE_TOOLS, ...plugins.flatMap((plugin) => plugin.tools ?? [])])].join(",");

export const pluginLine = (plugins: ReadonlyArray<Plugin>): string => (plugins.length === 0 ? "" : `[terrarium:plugins] loaded ${plugins.map((plugin) => plugin.name).join(", ")}`);
