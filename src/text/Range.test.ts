import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point } from './Point.ts';
import { Range } from './Range.ts';

test('constructor normalizes endpoints so start <= end', () => {
  const r = new Range([5, 0], [2, 3]);
  assert.deepEqual(r.start.toArray(), [2, 3]);
  assert.deepEqual(r.end.toArray(), [5, 0]);
});

test('a single-point range is empty and single-line', () => {
  const r = new Range([1, 4], [1, 4]);
  assert.ok(r.isEmpty());
  assert.ok(r.isSingleLine());
  assert.equal(r.getRowCount(), 1);
});

test('row helpers', () => {
  const r = new Range([2, 1], [4, 0]);
  assert.equal(r.getRowCount(), 3);
  assert.deepEqual(r.getRows(), [2, 3, 4]);
  assert.ok(r.intersectsRow(3));
  assert.ok(!r.intersectsRow(5));
  assert.ok(r.intersectsRowRange(0, 2));
});

test('union covers both ranges', () => {
  const u = new Range([2, 0], [3, 0]).union(new Range([1, 5], [2, 8]));
  assert.deepEqual(u.start.toArray(), [1, 5]);
  assert.deepEqual(u.end.toArray(), [3, 0]);
});

test('containsPoint respects exclusivity at the boundaries', () => {
  const r = new Range([1, 0], [3, 0]);
  assert.ok(r.containsPoint([2, 0]));
  assert.ok(r.containsPoint([1, 0])); // inclusive of start
  assert.ok(!r.containsPoint([1, 0], true)); // exclusive of start
  assert.ok(!r.containsPoint([3, 1]));
});

test('containsRange', () => {
  const outer = new Range([1, 0], [5, 0]);
  assert.ok(outer.containsRange([[2, 0], [4, 0]]));
  assert.ok(!outer.containsRange([[0, 0], [4, 0]]));
});

test('intersectsWith and its exclusive form for touching ranges', () => {
  const a = new Range([1, 0], [2, 0]);
  const touching = new Range([2, 0], [3, 0]);
  assert.ok(a.intersectsWith(touching)); // share the point (2,0)
  assert.ok(!a.intersectsWith(touching, true)); // exclusive: touching only
  assert.ok(!a.intersectsWith(new Range([3, 0], [4, 0])));
});

test('getExtent returns the traversal delta from start to end', () => {
  const r = new Range([2, 3], [4, 1]);
  assert.deepEqual(r.getExtent().toArray(), new Point(4, 1).traversalFrom([2, 3]).toArray());
});

test('compare orders by start then by wider-range-first on ties', () => {
  assert.equal(new Range([1, 0], [2, 0]).compare([[1, 0], [3, 0]]), 1);
  assert.equal(new Range([0, 0], [1, 0]).compare([[1, 0], [2, 0]]), -1);
  assert.equal(new Range([1, 0], [2, 0]).compare([[1, 0], [2, 0]]), 0);
});
