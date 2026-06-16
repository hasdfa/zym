import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBracketPair } from './bracketMatch.ts';

test('matches an opener forward and a closer backward', () => {
  assert.deepEqual(findBracketPair('(a)', 0), [0, 2]); // on `(`
  assert.deepEqual(findBracketPair('(a)', 2), [2, 0]); // on `)`
});

test('respects nesting (same type)', () => {
  assert.deepEqual(findBracketPair('((a))', 0), [0, 4]);
  assert.deepEqual(findBracketPair('((a))', 1), [1, 3]);
  assert.deepEqual(findBracketPair('[a(b)c]', 0), [0, 6]);
  assert.deepEqual(findBracketPair('[a(b)c]', 2), [2, 4]);
});

test('matches the bracket just before the cursor (after typing a closer)', () => {
  // cursor at index 3, past the `)` at 2.
  assert.deepEqual(findBracketPair('(a)', 3), [2, 0]);
});

test('prefers the bracket under the cursor over the one before it', () => {
  // `()` with cursor on the `)` (index 1): the `)` under the cursor wins.
  assert.deepEqual(findBracketPair('()', 1), [1, 0]);
});

test('only matches the same bracket type', () => {
  assert.equal(findBracketPair('(]', 0), null); // no `)` → no match
  assert.deepEqual(findBracketPair('{[()]}', 0), [0, 5]);
  assert.deepEqual(findBracketPair('{[()]}', 1), [1, 4]);
  assert.deepEqual(findBracketPair('{[()]}', 2), [2, 3]);
});

test('highlights the innermost enclosing pair when the cursor is inside (not adjacent)', () => {
  assert.deepEqual(findBracketPair('(abc)', 2), [0, 4]); // on `b`, inside ( )
  assert.deepEqual(findBracketPair('foo(bar)', 5), [3, 7]); // on `a`, inside ( )
  assert.deepEqual(findBracketPair('([x])', 2), [1, 3]); // on `x`, innermost is [ ]
  assert.deepEqual(findBracketPair('{ a }', 2), [0, 4]); // on `a`, inside { }
});

test('enclosing scan skips already-balanced pairs to its left', () => {
  // cursor on the 2nd `c` (index 6, not adjacent to any bracket): only the outer
  // ( ) encloses it; the inner (b) is already balanced and skipped.
  assert.deepEqual(findBracketPair('(a(b)cc)', 6), [0, 7]);
});

test('a bracket adjacent to the cursor wins over the enclosing pair', () => {
  // `(a)` with cursor right after `(` (index 1): the `(` before it wins.
  assert.deepEqual(findBracketPair('(a)', 1), [0, 2]);
});

test('returns null with no bracket or no match', () => {
  assert.equal(findBracketPair('abc', 1), null);
  assert.equal(findBracketPair('(a', 0), null); // unmatched opener
  assert.equal(findBracketPair('a)', 1), null); // unmatched closer
  assert.equal(findBracketPair('', 0), null);
});
