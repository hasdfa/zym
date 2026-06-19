import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesToExcerptInputs } from './projectSearch.ts';

// Pure region-merge math — no rg, no GTK.

test('a single match becomes one context-padded region', () => {
  const out = matchesToExcerptInputs([{ path: 'a.ts', rows: [10] }], { context: 2 });
  assert.deepEqual(out, [{ path: 'a.ts', regions: [{ startRow: 8, endRow: 12 }] }]);
});

test('nearby matches merge into one region; far ones stay separate', () => {
  // rows 10 and 13 with context 2 → [8,12] and [11,15] overlap → merge to [8,15].
  // row 30 is far → its own [28,32].
  const out = matchesToExcerptInputs([{ path: 'a.ts', rows: [10, 13, 30] }], { context: 2 });
  assert.deepEqual(out, [{ path: 'a.ts', regions: [{ startRow: 8, endRow: 15 }, { startRow: 28, endRow: 32 }] }]);
});

test('regions that merely touch (gap of 1) still merge', () => {
  // rows 5 and 9 with context 1 → [4,6] and [8,10]; 8 <= 6+1+1? touching rule is start<=prevEnd+1
  // → 8 <= 7 is false, so they DON'T merge. rows 5 and 8 → [4,6],[7,9]: 7<=7 → merge to [4,9].
  assert.deepEqual(
    matchesToExcerptInputs([{ path: 'a.ts', rows: [5, 9] }], { context: 1 }),
    [{ path: 'a.ts', regions: [{ startRow: 4, endRow: 6 }, { startRow: 8, endRow: 10 }] }],
    'one blank line between regions keeps them separate',
  );
  assert.deepEqual(
    matchesToExcerptInputs([{ path: 'a.ts', rows: [5, 8] }], { context: 1 }),
    [{ path: 'a.ts', regions: [{ startRow: 4, endRow: 9 }] }],
    'touching regions merge',
  );
});

test('unsorted, duplicate rows are normalized', () => {
  const out = matchesToExcerptInputs([{ path: 'a.ts', rows: [13, 10, 10] }], { context: 2 });
  assert.deepEqual(out, [{ path: 'a.ts', regions: [{ startRow: 8, endRow: 15 }] }]);
});

test('context is clamped to the file bounds when a line count is known', () => {
  const out = matchesToExcerptInputs([{ path: 'a.ts', rows: [0, 20] }], {
    context: 3,
    lineCount: () => 22, // last row = 21
  });
  assert.deepEqual(out, [{ path: 'a.ts', regions: [{ startRow: 0, endRow: 3 }, { startRow: 17, endRow: 21 }] }]);
});

test('multiple files keep their first-seen order', () => {
  const out = matchesToExcerptInputs(
    [{ path: 'b.ts', rows: [1] }, { path: 'a.ts', rows: [1] }],
    { context: 0 },
  );
  assert.deepEqual(out.map((e) => e.path), ['b.ts', 'a.ts']);
});
