const SPAWN_TOOL_SUFFIXES = ["terrarium_spawn", "terrarium_spawn_batch"];

export function isTerrariumSpawnTool(name) {
  return typeof name === "string" && SPAWN_TOOL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`_${suffix}`));
}

export function claimedEvents(claimResponse) {
  const events = claimResponse?.result?.events ?? claimResponse?.events;
  return Array.isArray(events) ? events : [];
}
