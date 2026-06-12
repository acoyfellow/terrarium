import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCampaign, TECHNIQUE_FAMILIES } from '../src/campaign-synth.js';

test('synthetic campaign generator is deterministic and length-unbounded', () => {
  const a = generateCampaign({ campaignId: 'test', count: 1_000 });
  const b = generateCampaign({ campaignId: 'test', count: 1_000 });
  assert.deepEqual(a, b);
  assert.equal(a.turns.length, 1_000);
  assert.equal(a.counts.total, 1_000);
  assert.equal(a.counts.contained + a.counts.escapes, 1_000);
});

test('synthetic turns stay structured and image pool stays bounded', () => {
  const campaign = generateCampaign({ campaignId: 'shape', count: 144 });
  const images = new Set(campaign.turns.map((turn) => turn.imageUrl));
  assert.ok(images.size <= TECHNIQUE_FAMILIES.length + 1);
  for (const [index, turn] of campaign.turns.entries()) {
    assert.equal(turn.turn, index + 1);
    for (const field of ['title', 'technique', 'hypothesis', 'attempt', 'result', 'adaptation', 'verdict', 'imageUrl']) {
      assert.equal(typeof turn[field], 'string');
      assert.notEqual(turn[field], '');
    }
  }
});
