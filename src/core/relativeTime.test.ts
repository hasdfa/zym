import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { relativeTime } from './relativeTime.ts';

const NOW = 1_700_000_000_000; // fixed reference (ms)
const ago = (seconds: number) => relativeTime(NOW / 1000 - seconds, NOW);

describe('relativeTime', () => {
  it('labels each unit, singular vs plural', () => {
    assert.equal(ago(5), '5 seconds ago');
    assert.equal(ago(60), '1 minute ago');
    assert.equal(ago(3 * 3600), '3 hours ago');
    assert.equal(ago(24 * 3600), '1 day ago');
    assert.equal(ago(14 * 24 * 3600), '2 weeks ago');
    assert.equal(ago(60 * 24 * 3600), '1 month ago');
    assert.equal(ago(800 * 24 * 3600), '2 years ago');
  });

  it('rounds down within a unit', () => {
    assert.equal(ago(59), '59 seconds ago');
    assert.equal(ago(119), '1 minute ago');
  });

  it('treats now / future as "just now"', () => {
    assert.equal(ago(0), 'just now');
    assert.equal(ago(-100), 'just now'); // clock skew: future timestamp clamps to 0
  });

  it('returns "unknown" for a 0 (missing) timestamp', () => {
    assert.equal(relativeTime(0, NOW), 'unknown');
  });
});
