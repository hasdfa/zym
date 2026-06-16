import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStyleRuns, type StyleSpan } from './highlightRuns.ts';

// Build a span with sensible defaults; override what a case cares about.
let seq = 0;
function span(start: number, end: number, o: Partial<StyleSpan<string>> = {}): StyleSpan<string> {
  return {
    start, end, idx: o.idx ?? seq++,
    color: o.color ?? null, background: o.background ?? null,
    lineBackground: o.lineBackground ?? null, scale: o.scale ?? null,
    bold: o.bold ?? false, italic: o.italic ?? false,
    underline: o.underline ?? false, strikethrough: o.strikethrough ?? false,
  };
}

test('foreground: narrower capture wins, including suppression by an uncolored token', () => {
  // Broad @function over [0,10); a narrow uncolored identifier over [4,7).
  const runs = computeStyleRuns([
    span(0, 10, { color: 'fn', idx: 0 }),
    span(4, 7, { color: null, idx: 1 }), // uncolored — suppresses the broad color
  ]);
  // [0,4) fn, [4,7) default (dropped — blank), [7,10) fn
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.color]), [[0, 4, 'fn'], [7, 10, 'fn']]);
});

test('foreground: ties broken toward the later span (injected layers win)', () => {
  const runs = computeStyleRuns([
    span(0, 5, { color: 'base', idx: 0 }),
    span(0, 5, { color: 'inject', idx: 1 }),
  ]);
  assert.deepEqual(runs, [{ start: 0, end: 5, color: 'inject', background: null, lineBackground: null, scale: null, bold: false, italic: false, underline: false, strikethrough: false }]);
});

test('background layers under a recolored token (fenced code: bg + inner colors)', () => {
  // A code-fence background over [0,10); inner TS tokens recolor parts.
  const runs = computeStyleRuns([
    span(0, 10, { background: 'codebg', idx: 0 }),
    span(2, 5, { color: 'kw', idx: 1 }),
  ]);
  // The whole [0,10) keeps the background; [2,5) also gets the keyword color.
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.color, r.background]), [
    [0, 2, null, 'codebg'],
    [2, 5, 'kw', 'codebg'],
    [5, 10, null, 'codebg'],
  ]);
});

test('line background (block code) survives under injected token colors', () => {
  // A fenced code block's full-line background over [0,20); injected tokens recolor.
  const runs = computeStyleRuns([
    span(0, 20, { lineBackground: 'codeblock', idx: 0 }),
    span(4, 7, { color: 'kw', idx: 1 }),
  ]);
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.color, r.lineBackground]), [
    [0, 4, null, 'codeblock'],
    [4, 7, 'kw', 'codeblock'],
    [7, 20, null, 'codeblock'],
  ]);
});

test('bold + italic are additive where they overlap', () => {
  const runs = computeStyleRuns([
    span(0, 6, { bold: true, idx: 0 }),    // **...**
    span(3, 9, { italic: true, idx: 1 }),  // *...*
  ]);
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.bold, r.italic]), [
    [0, 3, true, false],
    [3, 6, true, true],
    [6, 9, false, true],
  ]);
});

test('scale is kept over an inner token that has none (code inside a heading)', () => {
  const runs = computeStyleRuns([
    span(0, 12, { color: 'head', scale: 1.5, bold: true, idx: 0 }),
    span(5, 9, { color: 'raw', background: 'codebg', idx: 1 }), // inline code in the heading
  ]);
  // The code run keeps the heading scale + bold, takes the code color + bg.
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.color, r.background, r.scale, r.bold]), [
    [0, 5, 'head', null, 1.5, true],
    [5, 9, 'raw', 'codebg', 1.5, true],
    [9, 12, 'head', null, 1.5, true],
  ]);
});

test('adjacent identical runs merge; blank gaps are dropped', () => {
  const runs = computeStyleRuns([
    span(0, 3, { color: 'a', idx: 0 }),
    span(3, 6, { color: 'a', idx: 1 }), // same style, adjacent → one run
    span(8, 10, { color: 'b', idx: 2 }), // gap [6,8) is blank
  ]);
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.color]), [[0, 6, 'a'], [8, 10, 'b']]);
});

test('empty input yields no runs', () => {
  assert.deepEqual(computeStyleRuns([]), []);
});
