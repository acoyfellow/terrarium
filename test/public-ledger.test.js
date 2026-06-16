import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPublicTurn, EMPTY_PUBLIC_CAMPAIGN, publicTurnFromReceipt } from '../src/public-ledger.js';

const receipt = {
  campaignId: 'campaign_real_1', fixture: false, backend: 'lab', scenarioId: 'lab-env-canary',
  body: 'SECRET BODY', capabilities: [], payloadHash: 'abc123', observed: 'Boundary held.',
  verdict: 'contained', verifiedVerdict: null, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z',
  execution: { resultId: 'run-a', result: false }, replay: null,
  artifactKey: 'private/key', payloadKey: 'private/payload', privateRunMetadata: { model: 'confidential-model-name', agent: 'private-runner' },
};

test('public ledger redacts payload and private artifact locations', () => {
  const turn = publicTurnFromReceipt(receipt, { hypothesis: 'try env', sourceRevision: 'deadbeef' });
  const encoded = JSON.stringify(turn);
  assert.equal(encoded.includes('SECRET BODY'), false);
  assert.equal(encoded.includes('private/'), false);
  assert.equal(encoded.includes('confidential-model-name'), false);
  assert.equal(encoded.includes('private-runner'), false);
  assert.equal(turn.payloadHash, 'abc123');
  assert.equal(turn.sourceRevision, 'unknown');
});

test('public ledger redacts copied text and requires distinct replay identity', () => {
  const secret = 'token=SUPER_PRIVATE_VALUE';
  const turn = publicTurnFromReceipt({ ...receipt, observed: secret, execution: { resultId: 'same' }, replay: { resultId: 'same', result: true } }, { hypothesis: secret, sourceRevision: 'a'.repeat(40), healing: { status: secret, issueUrl: 'https://evil.example/1', arbitrary: secret } });
  const encoded = JSON.stringify(turn);
  assert.equal(encoded.includes('SUPER_PRIVATE_VALUE'), false);
  assert.equal(encoded.includes('evil.example'), false);
  assert.equal(turn.evidence.independentReplay, false);
  assert.deepEqual(Object.keys(turn.healing).sort(), ['issueUrl', 'mergedRevision', 'prUrl', 'status']);
});

test('public ledger removes encoded secret material', () => {
  const encoded = Buffer.from('SUPER_SECRET_CANARY').toString('base64');
  const turn = publicTurnFromReceipt({ ...receipt, observed: encoded }, { hypothesis: `split:${encoded.slice(0, 8)}${encoded.slice(8)}`, sourceRevision: 'a'.repeat(40) });
  assert.equal(JSON.stringify(turn).includes(encoded), false);
});

test('public ledger rejects fixture receipts and counts real turns', () => {
  assert.throws(() => publicTurnFromReceipt({ ...receipt, fixture: true }), /real receipts only/);
  const contained = publicTurnFromReceipt(receipt);
  const escaped = publicTurnFromReceipt({ ...receipt, campaignId: 'campaign_real_2', verdict: 'escaped', verifiedVerdict: 'verified-escape', replay: { resultId: 'run-b', result: true } });
  const campaign = appendPublicTurn(appendPublicTurn(EMPTY_PUBLIC_CAMPAIGN, contained), escaped);
  assert.deepEqual(campaign.counts, { total: 2, contained: 1, escapes: 1 });
  assert.equal(campaign.updatedAt, escaped.finishedAt);
  assert.equal(campaign.turns[1].evidence.independentReplay, true);
  assert.equal(campaign.synthetic, false);
});
