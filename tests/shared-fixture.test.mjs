import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPoints } from '../src/core/format.js';
import { runSharedFixture } from '../src/core/sharedFixture.js';

test('shared pure-JS fixture returns independently expected value 30-15', () => {
  assert.equal(runSharedFixture(), '30-15');
});

test('formatPoints maps standard padel point counts', () => {
  assert.equal(formatPoints(0, 0), '0-0');
  assert.equal(formatPoints(1, 3), '15-40');
});
