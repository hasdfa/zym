import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point } from './Point.ts';

test('fromObject coerces arrays, objects, and points', () => {
  assert.deepEqual(Point.fromObject([2, 5]).toArray(), [2, 5]);
  assert.deepEqual(Point.fromObject({ row: 1, column: 3 }).toArray(), [1, 3]);
  const p = new Point(0, 0);
  assert.equal(Point.fromObject(p), p); // same instance without copy
  assert.notEqual(Point.fromObject(p, true), p); // fresh instance with copy
});

test('translate adds componentwise', () => {
  assert.deepEqual(new Point(2, 3).translate([1, 4]).toArray(), [3, 7]);
});

test('traverse folds the column into a new row when the row changes', () => {
  // same row: columns add
  assert.deepEqual(new Point(2, 3).traverse([0, 4]).toArray(), [2, 7]);
  // row changes: land on the new row at the delta column, original column dropped
  assert.deepEqual(new Point(2, 3).traverse([1, 4]).toArray(), [3, 4]);
});

test('traversalFrom inverts traverse', () => {
  const a = new Point(2, 3);
  const b = new Point(5, 1);
  assert.deepEqual(a.traverse(b.traversalFrom(a)).toArray(), b.toArray());
});

test('compare orders by row then column', () => {
  assert.equal(new Point(1, 0).compare([2, 0]), -1);
  assert.equal(new Point(2, 5).compare([2, 3]), 1);
  assert.equal(new Point(2, 3).compare([2, 3]), 0);
  assert.ok(new Point(0, 1).isGreaterThan(Point.ZERO));
  assert.ok(new Point(0, 0).isLessThanOrEqual([0, 0]));
});

test('sign predicates', () => {
  assert.ok(Point.ZERO.isZero());
  assert.ok(new Point(0, 1).isPositive());
  assert.ok(new Point(-1, 5).isNegative());
  assert.ok(!new Point(0, -1).isPositive());
});

test('min and max pick the right endpoint', () => {
  assert.deepEqual(Point.min([2, 0], [1, 9]).toArray(), [1, 9]);
  assert.deepEqual(Point.max([2, 0], [1, 9]).toArray(), [2, 0]);
});

test('ZERO and INFINITY are frozen constants', () => {
  assert.ok(Object.isFrozen(Point.ZERO));
  assert.ok(Point.INFINITY.isGreaterThan(new Point(1e9, 1e9)));
});
