const INHERITED_TERRARIUM_ENV = [
  'TERRARIUM_RUN_ID',
  'TERRARIUM_PARENT_RUN_ID',
  'TERRARIUM_DEPTH',
  'TERRARIUM_MAX_DEPTH',
  'TERRARIUM_ALLOW_SPAWN',
  'TERRARIUM_CHILD_BUDGET',
  'TERRARIUM_STATUS_SCOPE',
  'TERRARIUM_READ_SCOPE',
  'TERRARIUM_MRE_LOG_PATH',
];

export function stripInheritedTerrariumEnv(env = process.env) {
  const clean = { ...env };
  for (const key of INHERITED_TERRARIUM_ENV) delete clean[key];
  return clean;
}

export function clearInheritedTerrariumEnv() {
  for (const key of INHERITED_TERRARIUM_ENV) delete process.env[key];
}
