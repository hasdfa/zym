import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIndentation } from './detectIndentation.ts';

test('detects 4-space indentation', () => {
  assert.deepEqual(detectIndentation('def f():\n    a\n    if x:\n        b\nc\n'), { useSpaces: true, width: 4 });
});

test('detects 2-space indentation', () => {
  assert.deepEqual(detectIndentation('function f() {\n  a\n  if (x) {\n    b\n  }\n}\n'), {
    useSpaces: true,
    width: 2,
  });
});

test('detects tab indentation (no width — display width is a preference)', () => {
  assert.deepEqual(detectIndentation('func f() {\n\ta\n\tif x {\n\t\tb\n\t}\n}\n'), { useSpaces: false });
});

test('returns null when there is no indentation to learn from', () => {
  assert.equal(detectIndentation('a\nb\nc\n'), null);
  assert.equal(detectIndentation(''), null);
  assert.equal(detectIndentation('one two three\n'), null);
});

test('the most common step wins on inconsistent indentation', () => {
  // Mostly 2-space steps with one larger jump.
  assert.deepEqual(detectIndentation('a\n  b\n    c\n  d\n        e\n'), { useSpaces: true, width: 2 });
});

test('blank and whitespace-only lines are ignored', () => {
  assert.deepEqual(detectIndentation('a\n\n    b\n   \n    c\n'), { useSpaces: true, width: 4 });
});
