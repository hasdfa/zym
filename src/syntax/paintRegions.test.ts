import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeGaps, mergeRange, type LineRange } from './paintRegions.ts';

test('rangeGaps: empty set → the whole range is a gap', () => {
  assert.deepEqual(rangeGaps([], 5, 10), [[5, 10]]);
});

test('rangeGaps: fully covered → no gaps', () => {
  assert.deepEqual(rangeGaps([[0, 100]], 12, 18), []);
  assert.deepEqual(rangeGaps([[10, 20]], 10, 20), []);
});

test('rangeGaps: gaps before, between, and after covered ranges', () => {
  assert.deepEqual(rangeGaps([[10, 20]], 5, 30), [
    [5, 9],
    [21, 30],
  ]);
  assert.deepEqual(rangeGaps([[10, 20], [40, 50]], 0, 60), [
    [0, 9],
    [21, 39],
    [51, 60],
  ]);
});

test('rangeGaps: partial overlap at the leading edge (the common scroll case)', () => {
  // painted [20,340]; scrolled so the new window is [300,520] → only [341,520] is new.
  assert.deepEqual(rangeGaps([[20, 340]], 300, 520), [[341, 520]]);
});

test('rangeGaps: ignores ranges entirely outside the query', () => {
  assert.deepEqual(rangeGaps([[0, 5], [100, 200]], 10, 20), [[10, 20]]);
});

test('mergeRange: into empty', () => {
  assert.deepEqual(mergeRange([], 5, 10), [[5, 10]]);
});

test('mergeRange: disjoint keeps order', () => {
  assert.deepEqual(mergeRange([[10, 20]], 25, 30), [
    [10, 20],
    [25, 30],
  ]);
  assert.deepEqual(mergeRange([[40, 50]], 10, 20), [
    [10, 20],
    [40, 50],
  ]);
});

test('mergeRange: adjacent ranges coalesce', () => {
  assert.deepEqual(mergeRange([[10, 20]], 21, 25), [[10, 25]]);
  assert.deepEqual(mergeRange([[21, 25]], 10, 20), [[10, 25]]);
});

test('mergeRange: overlap coalesces', () => {
  assert.deepEqual(mergeRange([[10, 20]], 15, 30), [[10, 30]]);
});

test('mergeRange: bridges two ranges into one', () => {
  assert.deepEqual(mergeRange([[10, 20], [40, 50]], 21, 39), [[10, 50]]);
});

test('accumulate then re-query is fully covered (scroll down, then back up)', () => {
  let ranges: LineRange[] = [];
  ranges = mergeRange(ranges, 0, 100); // view top
  ranges = mergeRange(ranges, 80, 180); // scrolled down
  ranges = mergeRange(ranges, 160, 260); // further down
  assert.deepEqual(ranges, [[0, 260]]);
  // Scrolling back up over [50,150] needs no repaint.
  assert.deepEqual(rangeGaps(ranges, 50, 150), []);
});
