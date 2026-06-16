import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTraceEvent, EVENT_TYPES, publicTraceEvent } from '../src/trace-events.js';
import { publicSummary } from '../src/public-summary.js';

test('trace events are allowlisted, bounded, and redact obvious secrets', () => {
  assert.ok(EVENT_TYPES.has('detector_started'));
  assert.throws(() => publicTraceEvent('model_thought'), /unknown trace event/);
  const event = publicTraceEvent('detector_finished', { scenario: 'x', verdict: 'contained', message: 'token=SUPERSECRET' }, '2026-01-01T00:00:00Z');
  assert.equal(JSON.stringify(event).includes('SUPERSECRET'), false);
  let trace = {};
  for (let i = 0; i < 120; i++) trace = appendTraceEvent(trace, publicTraceEvent('planned', { message: String(i) }));
  assert.equal(trace.events.length, 100);
});

test('public summaries use trusted templates rather than attacker prose', () => {
  const summary = publicSummary('encoding-evasion-leak', 'contained');
  assert.match(summary.title, /secret/i);
  assert.doesNotMatch(JSON.stringify(summary), /payload|sha256|detector/i);
  assert.match(publicSummary('unknown', 'contained').title, /another way/);
});
