import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCampaignMemory, planSignature, rejectDuplicatePlans } from '../src/campaign-memory.js';
import { parsePlans, strategistPrompt } from '../src/campaign-strategist.js';

const plan = { scenario: 'run-id-traversal', family: 'encoding', target: 'run id parser', mechanism: 'unicode slash', expectedSignal: 'file outside namespace', novelty: 'unicode was not tried', priority: 1 };

test('memory stays bounded while preserving recent evidence and breakouts', () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({ turn: i + 1, scenarioId: `s${i}`, hypothesis: `h${i}`, result: `r${i}`, verdict: i === 4 ? 'verified-escape' : 'contained', sourceRevision: 'a'.repeat(40), payloadHash: `p${i}` }));
  const memory = buildCampaignMemory(turns, { revision: 'b'.repeat(40) });
  assert.equal(memory.recent.length, 10);
  assert.equal(memory.recent[0].turn, 21);
  assert.equal(memory.ruledOut.length, 20);
  assert.equal(memory.verifiedBreakouts.length, 1);
});

test('strategist parses bounded ranked machine output', () => {
  const parsed = parsePlans(`TERRARIUM_PLANS=${JSON.stringify([plan])}`);
  assert.deepEqual(parsed[0], plan);
  assert.throws(() => parsePlans('prose'), /missing/);
  assert.throws(() => parsePlans(`TERRARIUM_PLANS=${JSON.stringify([{ ...plan, priority: 99 }])}`), /priority/);
});

test('novelty gate rejects duplicate mechanisms deterministically', () => {
  const signature = planSignature(plan);
  const result = rejectDuplicatePlans([plan, { ...plan, mechanism: 'different' }], new Set([signature]));
  assert.equal(result.rejected.length, 1);
  assert.equal(result.accepted.length, 1);
});

test('prompt requests one compact ranked batch and carries memory', () => {
  const prompt = strategistPrompt({ memory: { ruledOut: ['direct path failed'] }, catalog: [{ id: 'run-id-traversal', surface: 'control-plane', boundary: 'stay inside' }], count: 8 });
  assert.match(prompt, /8 technically potent/);
  assert.match(prompt, /ONE call/);
  assert.match(prompt, /composition attacks/);
  assert.match(prompt, /direct path failed/);
  assert.match(prompt, /TERRARIUM_PLANS=/);
});
