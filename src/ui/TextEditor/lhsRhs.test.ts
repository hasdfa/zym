import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lhsRhsRanges } from './lhsRhs.ts';

// Helper: the substring a span covers, or null.
function piece(line: string, span: [number, number] | null): string | null {
  return span ? line.slice(span[0], span[1]) : null;
}

function pieces(line: string) {
  const r = lhsRhsRanges(line);
  if (!r) return null;
  return {
    lhsInner: piece(line, r.lhsInner),
    lhsA: piece(line, r.lhsA),
    rhsInner: piece(line, r.rhsInner),
    rhsA: piece(line, r.rhsA),
  };
}

test('a plain assignment: inner trims, a keeps the =', () => {
  assert.deepEqual(pieces('const value = [1, 2]'), {
    lhsInner: 'const value',
    lhsA: 'const value =',
    rhsInner: '[1, 2]',
    rhsA: '= [1, 2]',
  });
});

test('leading indentation is excluded from the LHS', () => {
  assert.deepEqual(pieces('    x = 42'), {
    lhsInner: 'x',
    lhsA: 'x =',
    rhsInner: '42',
    rhsA: '= 42',
  });
});

test('a trailing semicolon is excluded from the RHS', () => {
  const r = pieces('let a = foo();');
  assert.equal(r?.rhsInner, 'foo()');
  assert.equal(r?.rhsA, '= foo()');
});

test('compound and arrow operators are the separator', () => {
  assert.equal(pieces('let a += 1')?.rhsA, '+= 1');
  assert.equal(pieces('let a >>= 1')?.rhsA, '>>= 1');
  assert.equal(pieces('x => y')?.lhsInner, 'x');
  assert.equal(pieces('x => y')?.rhsInner, 'y');
  assert.equal(pieces('Lhs->Rhs("x")')?.rhsInner, 'Rhs("x")');
});

test('colon is used only when there is no assignment operator', () => {
  assert.deepEqual(pieces('key: "value"'), {
    lhsInner: 'key',
    lhsA: 'key:',
    rhsInner: '"value"',
    rhsA: ': "value"',
  });
  // With both, the `=` wins (colon inside the RHS is left alone).
  assert.equal(pieces('a = {x: 1}')?.rhsInner, '{x: 1}');
});

test('comparison operators are not treated as separators', () => {
  // No assignment → falls through; `==`/`<=`/`!=` are not separators, so these
  // lines have no `=`-family or `:` separator and return null.
  assert.equal(lhsRhsRanges('if (a == b)'), null);
  assert.equal(lhsRhsRanges('a <= b'), null);
  assert.equal(lhsRhsRanges('a !== b'), null);
});

test('return acts as a separator with an empty LHS', () => {
  const r = lhsRhsRanges('  return value');
  assert.equal(r?.lhsInner, null); // nothing before `return`
  assert.equal(piece('  return value', r!.rhsInner), 'value');
});

test('a line with no separator yields null', () => {
  assert.equal(lhsRhsRanges('justAWord'), null);
  assert.equal(lhsRhsRanges('   '), null);
});

test('columns are codepoints on non-BMP lines', () => {
  // The emoji is one codepoint but two UTF-16 units; the `=` sits at codepoint 4.
  const line = 'a😀b = 1';
  const r = lhsRhsRanges(line)!;
  assert.deepEqual(r.lhsInner, [0, 3]); // "a😀b" is 3 codepoints
  assert.deepEqual(r.lhsA, [0, 5]); // through "="
});
