import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPublicTurn, EMPTY_PUBLIC_CAMPAIGN, publicTurnFromReceipt } from '../src/public-ledger.js';

const receipt = {
  campaignId: 'campaign_real_1', fixture: false, backend: 'lab', scenarioId: 'lab-env-canary',
  body: 'SECRET BODY', capabilities: [], payloadHash: 'abc123', observed: 'Boundary held.',
  verdict: 'contained', verifiedVerdict: null, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z',
  execution: { resultId: 'run-a', result: false }, replay: null,
  artifactKey: 'private/key', payloadKey: 'private/payload',
};

test('public ledger redacts payload and private artifact locations', () => {
  const turn = publicTurnFromReceipt(receipt, { hypothesis: 'try env', sourceRevision: 'deadbeef' });
  const encoded = JSON.stringify(turn);
  assert.equal(encoded.includes('SECRET BODY'), false);
  assert.equal(encoded.includes('private/'), false);
  assert.equal(turn.payloadHash, 'abc123');
  assert.equal(turn.sourceRevision, 'deadbeef');
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
