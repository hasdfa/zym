import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point } from '../text/Point.ts';
import { Range } from '../text/Range.ts';
import {
  pathToUri,
  uriToPath,
  columnToCharacter,
  characterToColumn,
  pointToPosition,
  positionToPoint,
  rangeToLsp,
  lspToRange,
  advancePosition,
} from './position.ts';

test('pathToUri / uriToPath round-trip, including spaces', () => {
  assert.equal(pathToUri('/home/user/a.ts'), 'file:///home/user/a.ts');
  const p = '/home/user/a b+c.ts';
  assert.equal(uriToPath(pathToUri(p)), p);
  assert.ok(pathToUri(p).includes('%20')); // space is percent-encoded
});

test('ascii: column == character in every encoding', () => {
  const line = 'const x = 1';
  for (const enc of ['utf-8', 'utf-16', 'utf-32'] as const) {
    assert.equal(columnToCharacter(line, 6, enc), 6);
    assert.equal(characterToColumn(line, 6, enc), 6);
  }
});

test('astral char (emoji): codepoint vs utf-16 vs utf-8 units differ', () => {
  // "a😀b": 😀 is one codepoint, 2 UTF-16 units, 4 UTF-8 bytes.
  const line = 'a\u{1F600}b';
  // Column 2 = codepoint offset just after the emoji (before "b").
  assert.equal(columnToCharacter(line, 2, 'utf-16'), 3); // 1 + 2
  assert.equal(columnToCharacter(line, 2, 'utf-8'), 5); // 1 + 4
  assert.equal(columnToCharacter(line, 2, 'utf-32'), 2);
  // Inverse maps the unit offset back to codepoint column 2.
  assert.equal(characterToColumn(line, 3, 'utf-16'), 2);
  assert.equal(characterToColumn(line, 5, 'utf-8'), 2);
});

test('characterToColumn snaps a mid-surrogate utf-16 offset to its codepoint', () => {
  const line = 'a\u{1F600}b';
  // Offset 2 lands in the middle of the emoji's surrogate pair → column 1.
  assert.equal(characterToColumn(line, 2, 'utf-16'), 1);
});

test('offsets past end of line clamp', () => {
  const line = 'ab';
  assert.equal(columnToCharacter(line, 99, 'utf-16'), 2);
  assert.equal(characterToColumn(line, 99, 'utf-16'), 2);
});

test('Point <-> Position', () => {
  const line = 'x\u{1F600}y';
  const pos = pointToPosition(new Point(4, 2), line, 'utf-16');
  assert.deepEqual(pos, { line: 4, character: 3 });
  assert.deepEqual(positionToPoint({ line: 4, character: 3 }, line, 'utf-16').toArray(), [4, 2]);
});

test('Range <-> LSP Range across multiple lines', () => {
  const lines = ['let a = 1', 'b\u{1F600}c', ''];
  const lineAt = (row: number) => lines[row] ?? '';
  const range = new Range(new Point(0, 4), new Point(1, 2));
  const lsp = rangeToLsp(range, lineAt, 'utf-16');
  assert.deepEqual(lsp, { start: { line: 0, character: 4 }, end: { line: 1, character: 3 } });
  const back = lspToRange(lsp, lineAt, 'utf-16');
  assert.deepEqual([back.start.toArray(), back.end.toArray()], [[0, 4], [1, 2]]);
});

test('advancePosition: single-line text advances the character (encoding-aware)', () => {
  // utf-16: a surrogate pair (😀) is 2 code units; the line stays the same.
  assert.deepEqual(advancePosition({ line: 3, character: 5 }, 'abc', 'utf-16'), { line: 3, character: 8 });
  assert.deepEqual(advancePosition({ line: 3, character: 5 }, '😀', 'utf-16'), { line: 3, character: 7 });
  assert.deepEqual(advancePosition({ line: 3, character: 5 }, '😀', 'utf-8'), { line: 3, character: 9 }); // 4 bytes
  assert.deepEqual(advancePosition({ line: 3, character: 5 }, '😀', 'utf-32'), { line: 3, character: 6 }); // 1 codepoint
});

test('advancePosition: multi-line text moves to a new line, char measured on the last line', () => {
  // Two newlines → +2 lines; the end character is the last line measured fresh.
  assert.deepEqual(advancePosition({ line: 1, character: 4 }, 'x\nyy\nzzz', 'utf-16'), { line: 3, character: 3 });
  // A trailing newline lands at column 0 of the next line.
  assert.deepEqual(advancePosition({ line: 0, character: 2 }, 'ab\n', 'utf-16'), { line: 1, character: 0 });
});

test('advancePosition: empty text (pure insertion range) is a no-op end == start', () => {
  assert.deepEqual(advancePosition({ line: 2, character: 7 }, '', 'utf-16'), { line: 2, character: 7 });
});
