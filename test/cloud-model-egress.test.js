import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SANDBOX_RUNTIME_CONFIG,
  TerrariumSandbox,
  handleWorkersAiEgress,
  denyAllEgress,
  _testables,
} from '../src/cloud/terrarium-sandbox.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const endpoint = 'https://terrarium.coey.dev/_terrarium_model/v1/chat/completions';
const request = (body, extra = {}) => new Request(extra.url || endpoint, {
  method: extra.method || 'POST',
  headers: { 'content-type': 'application/json', ...(extra.headers || {}) },
  body: extra.method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
});

async function json(res) { return await res.json(); }

test('5D image/config wiring uses the Pi Dockerfile and an AI binding without credential vars', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile.pi'), 'utf8');
  const wrangler = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
  const provider = readFileSync(join(root, 'scripts/pi-runtime/terrarium-provider.mjs'), 'utf8');
  const runner = readFileSync(join(root, 'scripts/terrarium-runner-pi'), 'utf8');
  const worker = readFileSync(join(root, 'src/control-worker.js'), 'utf8');
  // Pi image is built on the plain amd64 sandbox base with a pinned Pi runtime.
  assert.match(dockerfile, /cloudflare\/sandbox:0\.12\.3@sha256:23f67e16/);
  assert.match(dockerfile, /@earendil-works\/pi-coding-agent@0\.80\.3/);
  assert.match(dockerfile, /COPY scripts\/terrarium-runner-pi \/usr\/local\/bin\/terrarium-runner/);
  assert.match(dockerfile, /COPY scripts\/pi-runtime\/terrarium-provider\.mjs \/etc\/terrarium\/terrarium-provider\.mjs/);
  // No OpenCode surface remains in the production image.
  assert.doesNotMatch(dockerfile, /opencode/i);
  assert.equal(wrangler.containers[0].image, './Dockerfile.pi');
  assert.equal(wrangler.containers[0].image_build_context, '.');
  assert.deepEqual(wrangler.ai, { binding: 'AI' });
  // The credentialless provider extension points Pi at the intercepted route
  // via TERRARIUM_MODEL_BASE_URL and carries only a nonsecret placeholder key.
  assert.match(provider, /pi\.registerProvider\("terrarium"/);
  assert.match(provider, /api: "openai-completions"/);
  assert.match(provider, /terrarium-nonsecret-placeholder/);
  assert.match(provider, /TERRARIUM_MODEL_BASE_URL/);
  assert.match(runner, /must select the fixed Terrarium Workers AI model/);
  assert.match(runner, /--provider terrarium --model workers-ai/);
  assert.doesNotMatch(runner, /opencode/i);
  assert.match(worker, /export \{ ContainerProxy \} from ["']@cloudflare\/containers["']/,
    'outbound interception requires ContainerProxy at the deployed worker entrypoint');
  const configText = JSON.stringify({ vars: wrangler.vars }) + provider;
  assert.doesNotMatch(configText, /sk-|api[_-]?token|bearer\s+[A-Za-z0-9]/i);
});

test('5D sandbox declarations deny internet and allow exactly the intercepted model host with Node CA trust', () => {
  assert.equal(SANDBOX_RUNTIME_CONFIG.enableInternet, false);
  assert.equal(SANDBOX_RUNTIME_CONFIG.interceptHttps, true);
  assert.deepEqual([...SANDBOX_RUNTIME_CONFIG.allowedHosts], ['terrarium.coey.dev']);
  assert.equal(SANDBOX_RUNTIME_CONFIG.envVars.TERRARIUM_MODEL, 'terrarium/workers-ai');
  assert.equal(SANDBOX_RUNTIME_CONFIG.envVars.TERRARIUM_MODEL_BASE_URL, 'https://terrarium.coey.dev/_terrarium_model/v1');
  assert.equal(SANDBOX_RUNTIME_CONFIG.envVars.TERRARIUM_PI_PROVIDER, '/etc/terrarium/terrarium-provider.mjs');
  assert.equal(SANDBOX_RUNTIME_CONFIG.envVars.NODE_EXTRA_CA_CERTS, '/etc/cloudflare/certs/cloudflare-containers-ca.crt');
  // No OpenCode config leaks into the Pi cell.
  assert.equal(Object.keys(SANDBOX_RUNTIME_CONFIG.envVars).some((k) => /^OPENCODE_/.test(k)), false);
  assert.equal(Object.keys(SANDBOX_RUNTIME_CONFIG.envVars).some((k) => /key|token|secret/i.test(k)), false);
  const sandboxSource = readFileSync(join(root, 'src/cloud/terrarium-sandbox.js'), 'utf8');
  assert.doesNotMatch(sandboxSource, /static outboundByHost\s*=/,
    'native static class fields bypass the inherited Container registry setter');
  assert.match(sandboxSource, /TerrariumSandbox\.outboundByHost\s*=/,
    'post-class assignment invokes the inherited setter in Workers');
  assert.equal(TerrariumSandbox.outboundByHost['terrarium.coey.dev'], handleWorkersAiEgress);
  assert.equal(TerrariumSandbox.outbound, denyAllEgress);
});

test('5D exact-host model handler rejects unknown host, path, method, malformed and oversized requests', async () => {
  const ai = { AI: { run: async () => ({ response: 'no' }) } };
  assert.equal((await handleWorkersAiEgress(request({ messages: [{ role: 'user', content: 'x' }] }, { url: 'https://other.invalid/v1/chat/completions' }), ai)).status, 404);
  assert.equal((await handleWorkersAiEgress(request({ messages: [{ role: 'user', content: 'x' }] }, { url: 'https://terrarium.coey.dev/_terrarium_model/v1/models' }), ai)).status, 404);
  assert.equal((await handleWorkersAiEgress(request(null, { method: 'GET' }), ai)).status, 405);
  assert.equal((await handleWorkersAiEgress(request('{'), ai)).status, 400);
  assert.equal((await handleWorkersAiEgress(request({ messages: [] }), ai)).status, 400);
  const tooLarge = request({ messages: [{ role: 'user', content: 'x' }] }, { headers: { 'content-length': String(_testables.MAX_REQUEST_BYTES + 1) } });
  assert.equal((await handleWorkersAiEgress(tooLarge, ai)).status, 413);
  assert.equal((await denyAllEgress()).status, 403);
});

test('5D handler normalizes OpenAI array/null message content to plain strings for Workers AI', async () => {
  // Regression for live AiError 5006: Pi's OpenAI client sends content as
  // structured parts or null; Workers AI chat models require string content.
  const body = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys ' }, { type: 'text', text: 'prompt' }] },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null },
    ],
  };
  const calls = [];
  const env = { AI: { run: async (...args) => { calls.push(args); return { response: 'ok' }; } } };
  const res = await handleWorkersAiEgress(request(body), env);
  assert.equal(res.status, 200);
  const sent = calls[0][1].messages;
  assert.equal(sent[0].content, 'sys prompt');
  assert.equal(sent[1].content, 'hi');
  assert.equal(sent[2].content, '');
  for (const m of sent) assert.equal(typeof m.content, 'string');
});

test('5D handler retries a transient upstream 5xx then succeeds, but does not retry a 4xx', async () => {
  // Transient AiError on first attempt, success on second.
  let n = 0;
  const flaky = { AI: { run: async () => {
    n += 1;
    if (n === 1) throw Object.assign(new Error('5006: capacity'), { name: 'AiError' });
    return { response: 'recovered' };
  } } };
  const res = await handleWorkersAiEgress(request({ messages: [{ role: 'user', content: 'x' }] }), flaky);
  assert.equal(res.status, 200);
  assert.equal(n, 2, 'should retry once and succeed');
  const completion = await json(res);
  assert.equal(completion.choices[0].message.content, 'recovered');

  // A non-transient error (explicit <500 status) is not retried.
  let m = 0;
  const hard = { AI: { run: async () => { m += 1; throw Object.assign(new Error('bad request'), { status: 400 }); } } };
  const bad = await handleWorkersAiEgress(request({ messages: [{ role: 'user', content: 'x' }] }), hard);
  assert.equal(bad.status, 400);
  assert.equal(m, 1, 'must not retry a 4xx');
});

test('5D handler fails closed without AI and selects fixed server model instead of client model', async () => {
  const body = { model: 'attacker/model', messages: [{ role: 'user', content: 'hello' }] };
  assert.equal((await handleWorkersAiEgress(request(body), {})).status, 503);
  const calls = [];
  const env = { AI: { run: async (...args) => { calls.push(args); return { response: 'world' }; } } };
  const res = await handleWorkersAiEgress(request(body), env);
  assert.equal(res.status, 200);
  assert.equal(calls[0][0], _testables.WORKERS_AI_MODEL);
  assert.equal('model' in calls[0][1], false);
  const completion = await json(res);
  assert.equal(completion.model, _testables.WORKERS_AI_MODEL);
  assert.equal(completion.choices[0].message.content, 'world');
});

test('5D handler preserves OpenAI choices/tool_calls and emits bounded SSE on request', async () => {
  const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }];
  const env = { AI: { run: async () => ({
    id: 'chatcmpl-x',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
    usage: { total_tokens: 4 },
  }) } };
  const normal = await handleWorkersAiEgress(request({ messages: [{ role: 'user', content: 'use tool' }], tools: [] }), env);
  const normalBody = await json(normal);
  assert.deepEqual(normalBody.choices[0].message.tool_calls, toolCalls);
  const streamed = await handleWorkersAiEgress(request({ messages: [{ role: 'user', content: 'use tool' }], tools: [], stream: true }), env);
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
  const text = await streamed.text();
  assert.match(text, /"tool_calls"/);
  assert.match(text, /data: \[DONE\]/);
  assert.ok(new TextEncoder().encode(text).byteLength <= _testables.MAX_RESPONSE_BYTES);
});

test('5D unsupported Workers AI output never becomes a completion', async () => {
  const res = await handleWorkersAiEgress(
    request({ messages: [{ role: 'user', content: 'x' }] }),
    { AI: { run: async () => ({ unexpected: true }) } },
  );
  assert.equal(res.status, 502);
  assert.equal((await json(res)).error.type, 'terrarium_model_error');
});
