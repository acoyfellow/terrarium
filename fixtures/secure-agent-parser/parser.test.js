import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePort } from './parser.js';

test('accepts valid integer ports', () => {
  assert.equal(parsePort('8080'), 8080);
});

test('rejects fractional and out-of-range ports', () => {
  for (const value of ['1.5', '0', '-1', '65536']) {
    assert.throws(() => parsePort(value), /invalid port/);
  }
});
