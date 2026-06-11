function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

export const DEFAULT_LAB_POLICY = {
  maxPayloadBytes: 4096,
  maxRuntimeMs: 1000,
  maxOutputBytes: 8192,
  allowCapabilities: [],
  allowSpawn: false,
  allowGenerate: false,
  allowNetwork: false,
  allowKv: false,
  allowR2: false,
  allowD1: false,
  allowWorkersAi: false,
  allowDurableObjectFetch: false,
  allowContainerHttp: false,
  requireFreshReplay: true,
  allowIssuePublish: false,
  allowFixPr: false,
  allowAutoMerge: false,
};

export function validateLabPayload({ body, capabilities = [] } = {}, policy = DEFAULT_LAB_POLICY) {
  if (typeof body !== "string" || body.trim() === "") throw new Error("Lab payload body required");
  if (byteLength(body) > policy.maxPayloadBytes) throw new Error(`Lab payload exceeds maxPayloadBytes (${policy.maxPayloadBytes})`);
  if (!Array.isArray(capabilities)) throw new Error("Lab capabilities must be an array");
  for (const capability of capabilities) {
    if (!policy.allowCapabilities.includes(capability)) throw new Error(`Lab capability not allowed: ${capability}`);
  }
  return { body, capabilities };
}

export async function runLabPayload({ baseUrl, body, capabilities = [], authToken, fetcher = fetch, policy = DEFAULT_LAB_POLICY } = {}) {
  const payload = validateLabPayload({ body, capabilities }, policy);
  if (!baseUrl) throw new Error("Lab baseUrl required");
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(policy.maxRuntimeMs),
  });
  if (!response.ok) throw new Error(`Lab run failed: ${response.status}`);
  const result = await response.json();
  const outputBytes = byteLength(JSON.stringify(result));
  if (outputBytes > policy.maxOutputBytes) throw new Error(`Lab output exceeds maxOutputBytes (${policy.maxOutputBytes})`);
  return result;
}

export function normalizeLabReceipt({ scenarioId, body, capabilities = [], run, replay, policy = DEFAULT_LAB_POLICY } = {}) {
  if (!run) throw new Error("Lab run required");
  const escaped = run.result === true;
  const replayEscaped = replay?.result === true;
  return {
    backend: "lab",
    scenarioId,
    body,
    capabilities,
    policy,
    verdict: escaped ? "escaped" : "contained",
    observed: escaped ? "Lab payload returned the forbidden condition." : "Lab payload did not return the forbidden condition.",
    execution: {
      resultId: run.resultId,
      result: run.result,
    },
    replay: replay ? {
      resultId: replay.resultId,
      result: replay.result,
      verdict: replayEscaped ? "escaped" : "contained",
    } : null,
    verifiedVerdict: replay ? (replayEscaped ? "verified-escape" : "contained") : null,
  };
}
