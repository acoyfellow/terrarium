const DAY = 86_400_000;

const attempt = (passed, answer, n) => ({
  runId: `ter_dev${n.toString(36).padStart(4, '0')}_${'a1b2c3d4e5f6'.slice(0, 12)}`,
  status: 'done',
  verified: true,
  logs: `TASK_RECEIVED\n${answer}\nTASK_ENDED`,
  gate: { passed, reason: passed ? 'answer contains the expected text' : 'answer does not contain the expected text' },
});

const seed = () => {
  const now = Date.now();
  const made = (goal, task, expect, maxAttempts, ageMs, shape) => ({ loopId: `loop_dev${Math.random().toString(16).slice(2, 14)}`, contract: { goal, task, expect, maxAttempts }, createdAt: new Date(now - ageMs).toISOString(), shape, startedMs: now - ageMs });

  return [
    made('Multiply two numbers', 'What is 17 multiplied by 23? Reply with just the number.', '391', 3, 40_000, { kind: 'running', answers: ['381'], script: ['381', '371', '391'], slowMs: 45_000 }),
    made('Name the capital', 'What is the capital of Australia? One word.', 'Canberra', 3, 12_000, { kind: 'running', answers: [], script: ['Sydney', 'Canberra'], slowMs: 60_000 }),
    made('Summarize the changelog', 'Summarize the last release notes in one sentence.', 'Effect', 2, 2 * 3600_000, { kind: 'passed', answers: ['Terrarium moved to Effect 4.'] }),
    made('Prime check', 'Is 221 prime? Answer yes or no.', 'no', 3, 5 * 3600_000, { kind: 'passed', answers: ['yes', 'no'] }),
    made('Kumquat never', 'What is 17 multiplied by 23? Reply with just the number.', 'kumquat-never', 2, 1 * DAY, { kind: 'exhausted', answers: ['391', '391'] }),
    made('Haiku about receipts', 'Write a haiku about receipts.', 'receipt', 3, 2 * DAY, { kind: 'passed', answers: ['Paper trail of proof / each receipt a quiet vow / the run was real here'] }),
    made('Reverse a word', 'Reverse the word terrarium.', 'muirarret', 5, 3 * DAY, { kind: 'exhausted', answers: ['muirarrat', 'muirarrte', 'muirarret?', 'muirraret', 'muirarre'] }),
    made('Count vowels', 'How many vowels are in "Cloudflare"? Just the number.', '4', 3, 4 * DAY, { kind: 'passed', answers: ['4'] }),
    made('Old cancelled loop', 'Wait forever.', 'never', 3, 6 * DAY, { kind: 'cancelled', answers: [] }),
    made('Translate hello', 'Say hello in French. One word.', 'Bonjour', 2, 9 * DAY, { kind: 'passed', answers: ['Bonjour'] }),
    made('Broken workflow', 'Trigger a workflow error.', 'x', 2, 11 * DAY, { kind: 'errored', answers: [] }),
  ];
};

const view = (loop) => {
  const { shape } = loop;
  const elapsed = Date.now() - loop.startedMs;
  const script = shape.script ?? [...shape.answers, 'still working', loop.contract.expect];
  const answers = shape.kind === 'running' ? script.slice(0, Math.min(shape.answers.length + Math.floor(elapsed / (shape.slowMs ?? 15_000)), loop.contract.maxAttempts)) : shape.answers;
  const attempts = answers.map((answer, i) => attempt(answer.includes(loop.contract.expect), answer, i + 1));
  const passed = attempts.at(-1)?.gate.passed === true;
  const running = shape.kind === 'running' && !passed && attempts.length < loop.contract.maxAttempts;
  const base = { loopId: loop.loopId, contract: loop.contract, createdAt: loop.createdAt };

  if (shape.kind === 'cancelled') return { ...base, status: 'terminated', output: null, error: null };
  if (shape.kind === 'errored') return { ...base, status: 'errored', output: null, error: { name: 'WorkflowError', message: 'sandbox: container failed to start' } };
  if (running) return { ...base, status: 'running', output: { attempts }, error: null };

  const outcome = passed ? 'passed' : 'exhausted';
  const reason = passed ? `attempt ${attempts.length} passed the gate` : `${attempts.length} of ${loop.contract.maxAttempts} attempts used, none passed`;

  return { ...base, status: 'complete', output: { decision: { action: 'stop', outcome, reason }, attempts }, error: null };
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
});

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

export const devLoopsMock = () => ({
  name: 'dev-loops-mock',
  apply: 'serve',
  configureServer(server) {
    let loops = seed();

    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://dev');
      if (!url.pathname.startsWith('/api/loops')) return next();
      const [, , , loopId, action] = url.pathname.split('/');
      const loop = loops.find((candidate) => candidate.loopId === loopId);

      if (req.method === 'GET' && !loopId) return send(res, 200, { loops: loops.map(view) });
      if (req.method === 'POST' && !loopId) {
        const contract = await readBody(req);
        if (!contract.goal || !contract.task || !contract.expect) return send(res, 400, { error: 'BadRequest', detail: { problems: ['goal, task and expect are required'] } });
        const created = { loopId: `loop_dev${Math.random().toString(16).slice(2, 14)}`, contract: { maxAttempts: 3, ...contract }, createdAt: new Date().toISOString(), startedMs: Date.now(), shape: { kind: 'running', answers: [] } };
        created.shape = { kind: 'running', answers: [], script: ['not quite', created.contract.expect] };
        loops = [created, ...loops];
        return send(res, 202, { loopId: created.loopId, contract: created.contract });
      }
      if (!loop) return send(res, 404, { error: 'NotFound' });
      if (req.method === 'GET') return send(res, 200, view(loop));
      if (req.method === 'POST' && action === 'cancel') { loop.shape = { ...loop.shape, kind: 'cancelled' }; return send(res, 200, view(loop)); }
      if (req.method === 'DELETE') { loops = loops.filter((candidate) => candidate !== loop); return send(res, 200, { ok: true, loopId }); }
      return next();
    });
  },
});
